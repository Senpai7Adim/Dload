from __future__ import annotations
from typing import Any
from fastapi import FastAPI, Request, Form, BackgroundTasks
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.background import BackgroundTask
import yt_dlp
import uuid
import os
import re

app = FastAPI()

DOWNLOAD_DIR = "/tmp/downloads"
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Global dictionary to track progress of downloads
download_progress: dict[str, Any] = {}

# Platforms that deliver pre-merged video+audio streams (no separate streams to combine)
MERGED_STREAM_DOMAINS = (
    "facebook.com", "fb.watch", "fb.com",
    "tiktok.com", "vm.tiktok.com",
    "instagram.com", "instagr.am",
    "twitter.com", "x.com", "t.co",
)

def is_merged_stream_url(url: str) -> bool:
    """Return True for platforms that serve pre-merged video+audio (no +bestaudio needed)."""
    url_lower = url.lower()
    return any(domain in url_lower for domain in MERGED_STREAM_DOMAINS)

def resolve_entry_url(entry: dict) -> str | None:
    """
    Get the best usable URL from a flat-extracted playlist entry.
    Flat extraction often returns just a numeric ID in `url` for non-YouTube platforms.
    We prefer `webpage_url`, then fall back to building from extractor info, then bare `url`.
    """
    webpage_url = entry.get("webpage_url")
    if webpage_url and webpage_url.startswith("http"):
        return webpage_url

    bare_url = entry.get("url", "")

    # If it looks like a real URL, use it
    if bare_url.startswith("http"):
        return bare_url

    # Try to reconstruct from extractor + id
    extractor = (entry.get("ie_key") or entry.get("extractor") or "").lower()
    video_id = entry.get("id") or bare_url

    reconstructed = {
        "youtube": f"https://www.youtube.com/watch?v={video_id}",
        "facebook": f"https://www.facebook.com/watch?v={video_id}",
        "tiktok": None,   # TikTok URLs can't be reconstructed from ID alone
        "instagram": None,
        "twitter": None,
    }
    for key, tmpl in reconstructed.items():
        if extractor.startswith(key) and tmpl:
            return tmpl

    # Last resort — return whatever we have
    return bare_url or None


# Common yt-dlp options shared across requests
BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "socket_timeout": 30,
    "retries": 5,
    "http_headers": {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    },
}


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.post("/info")
async def info(url: str = Form(...)):
    is_search = False
    query = url
    if not url.startswith("http://") and not url.startswith("https://"):
        is_search = True
        query = f"ytsearch5:{url}"

    ydl_opts = {
        **BASE_YDL_OPTS,
        "extract_flat": "in_playlist" if not is_search else True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        try:
            info_data = ydl.extract_info(query, download=False)
        except Exception as e:
            return JSONResponse(status_code=400, content={"error": str(e)})

    if "entries" in info_data:
        # Playlist or search results
        entries = []
        for entry in info_data.get("entries") or []:
            if not entry:
                continue
            entry_url = resolve_entry_url(entry)
            thumbnails = entry.get("thumbnails") or []
            thumbnail = thumbnails[-1].get("url") if thumbnails else entry.get("thumbnail")
            entries.append({
                "title": entry.get("title") or "Untitled",
                "url": entry_url,
                "thumbnail": thumbnail,
                "duration": entry.get("duration"),
            })
        return {
            "is_playlist": True,
            "title": "Search Results" if is_search else info_data.get("title", "Playlist"),
            "entries": entries,
            "url": url,
        }

    # Single video — extract formats
    formats = []
    for f in info_data.get("formats") or []:
        filesize = f.get("filesize") or f.get("filesize_approx") or 0
        vcodec = f.get("vcodec") or "none"
        acodec = f.get("acodec") or "none"
        height = f.get("height")
        resolution = f.get("resolution") or (f"{height}p" if height else None) or "unknown"

        if vcodec != "none" and acodec != "none":
            # Pre-merged (e.g. TikTok, Facebook, or YouTube combined formats)
            formats.append({
                "format_id": f.get("format_id"),
                "resolution": resolution,
                "ext": f.get("ext"),
                "type": "video",
                "filesize": filesize,
                "tbr": f.get("tbr") or 0,
            })
        elif vcodec == "none" and acodec != "none":
            # Audio only
            formats.append({
                "format_id": f.get("format_id"),
                "resolution": "Audio",
                "ext": f.get("ext"),
                "type": "audio",
                "filesize": filesize,
                "tbr": f.get("tbr") or 0,
            })
        elif vcodec != "none" and acodec == "none":
            # Video only (will be merged with audio at download time)
            formats.append({
                "format_id": f.get("format_id"),
                "resolution": resolution,
                "ext": f.get("ext"),
                "type": "video",
                "filesize": filesize,
                "tbr": f.get("tbr") or 0,
            })

    # Deduplicate by (type, resolution, ext), keeping highest bitrate
    unique: dict[str, Any] = {}
    for f in formats:
        key = f"{f['type']}_{f['resolution']}_{f['ext']}"
        if key not in unique or float(f.get("tbr") or 0) > float(unique[key].get("tbr") or 0):
            unique[key] = f

    final_formats = list(unique.values())
    # Sort: audio first, then video by descending bitrate
    final_formats.sort(key=lambda x: (0 if x["type"] == "audio" else 1, -(x.get("tbr") or 0)))

    return {
        "is_playlist": False,
        "title": info_data.get("title"),
        "thumbnail": info_data.get("thumbnail"),
        "url": url,
        "formats": final_formats,
    }


def download_worker(task_id: str, url: str, format_id: str):
    file_path_template = f"{DOWNLOAD_DIR}/%(title)s_{task_id}.%(ext)s"
    _ansi = re.compile(r"\x1b\[[0-9;]*m")

    def my_hook(d):
        if d["status"] == "downloading":
            raw_pct = _ansi.sub("", d.get("_percent_str", "0.0%")).replace("%", "").strip()
            try:
                percent = float(raw_pct)
            except ValueError:
                percent = 0.0
            download_progress[task_id] = {
                "status": "downloading",
                "percent": percent,
                "speed": _ansi.sub("", d.get("_speed_str", "N/A")),
                "eta": _ansi.sub("", d.get("_eta_str", "N/A")),
            }
        elif d["status"] == "finished":
            download_progress[task_id] = {
                "status": "finished",
                "percent": 100.0,
                "filename": d.get("filename"),
            }

    # Determine if this platform uses pre-merged streams
    merged = is_merged_stream_url(url)

    if format_id in ("mp3", "bestaudio"):
        # Audio extraction
        ydl_opts = {
            **BASE_YDL_OPTS,
            "format": "bestaudio/best",
            "outtmpl": file_path_template,
            "progress_hooks": [my_hook],
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
            }],
        }
    elif merged or format_id in ("best", ""):
        # Merged-stream platform OR generic "best" — don't combine streams
        ydl_opts = {
            **BASE_YDL_OPTS,
            "format": "best",
            "merge_output_format": "mp4",
            "outtmpl": file_path_template,
            "progress_hooks": [my_hook],
        }
    else:
        # YouTube-style: combine selected video stream with best audio
        ydl_opts = {
            **BASE_YDL_OPTS,
            "format": f"{format_id}+bestaudio/best",
            "merge_output_format": "mp4",
            "outtmpl": file_path_template,
            "progress_hooks": [my_hook],
        }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
    except Exception as e:
        download_progress[task_id] = {
            "status": "error",
            "error": str(e),
        }


@app.post("/start_download")
async def start_download(
    background_tasks: BackgroundTasks,
    url: str = Form(...),
    format_id: str = Form("best"),
):
    task_id = str(uuid.uuid4())
    download_progress[task_id] = {"status": "starting", "percent": 0.0}
    background_tasks.add_task(download_worker, task_id, url, format_id)
    return {"task_id": task_id}


@app.get("/progress/{task_id}")
async def get_progress(task_id: str):
    return download_progress.get(task_id, {"status": "not_found"})


@app.get("/serve_file/{task_id}")
async def serve_file(task_id: str):
    from urllib.parse import quote

    # Find the file on disk (works even after server restarts)
    matched_file: str | None = None
    for f in os.listdir(DOWNLOAD_DIR):
        if task_id in f and not f.endswith(".part"):
            matched_file = f
            break

    if matched_file is None:
        info = download_progress.get(task_id)
        if info and info.get("status") == "downloading":
            return JSONResponse(status_code=400, content={"error": "Download still in progress"})
        return JSONResponse(status_code=404, content={"error": "File not found on disk"})

    path = f"{DOWNLOAD_DIR}/{matched_file}"
    clean_filename = matched_file.replace(f"_{task_id}", "")

    # RFC 5987 encoding so Unicode filenames don't crash the server
    encoded_filename = quote(clean_filename, safe="")
    ascii_fallback = clean_filename.encode("ascii", "replace").decode()
    content_disposition = (
        f"attachment; "
        f'filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{encoded_filename}"
    )

    # Delete the file from disk after it's been streamed to save space
    # (important on Render's ephemeral filesystem)
    def cleanup():
        try:
            os.remove(path)
            download_progress.pop(task_id, None)
        except OSError:
            pass

    return FileResponse(
        path,
        media_type="application/octet-stream",
        headers={"Content-Disposition": content_disposition},
        background=BackgroundTask(cleanup),
    )
