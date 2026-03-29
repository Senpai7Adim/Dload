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
    # 1. Direct webpage_url is always best
    webpage_url = entry.get("webpage_url")
    if webpage_url and webpage_url.startswith("http"):
        return webpage_url

    # 2. If 'url' looks like a full URL, use it
    bare_url = entry.get("url", "")
    if bare_url and bare_url.startswith("http"):
        return bare_url

    # 3. Reconstruct from ID and extractor
    extractor = (entry.get("ie_key") or entry.get("extractor") or "").lower()
    video_id = entry.get("id") or (bare_url if bare_url and not bare_url.startswith("http") else None)
    
    if not video_id:
        return None

    reconstructed = {
        "youtube": f"https://www.youtube.com/watch?v={video_id}",
        "facebook": f"https://www.facebook.com/watch?v={video_id}",
        "vimeo": f"https://vimeo.com/{video_id}",
        "dailymotion": f"https://www.dailymotion.com/video/{video_id}",
        "tiktok": None, # TikTok needs more than just ID
        "instagram": None,
        "twitter": None,
    }
    
    for key, tmpl in reconstructed.items():
        if key in extractor and tmpl:
            return tmpl

    # 4. If nothing else works and it's not a URL, it's just an ID we can't use directly
    return None


class YDLLogger:
    def debug(self, msg):
        # yt-dlp debug messages can be very verbose, only care about progress
        if msg.startswith("[debug] ") or msg.startswith("[download] "):
            pass
        else:
            print(f"[YDL-DEBUG] {msg}")

    def info(self, msg):
        print(f"[YDL-INFO] {msg}")

    def warning(self, msg):
        print(f"[YDL-WARNING] {msg}")

    def error(self, msg):
        print(f"[YDL-ERROR] {msg}")

# Common yt-dlp options shared across requests
BASE_YDL_OPTS = {
    "quiet": True,
    "no_warnings": False,
    "logger": YDLLogger(),
    "socket_timeout": 30,
    "retries": 10,
    "fragment_retries": 10,
    "http_headers": {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/123.0.0.0 Safari/537.36"
        )
    },
    "nocheckcertificate": True,
    "geo_bypass": True,
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

    # Single video — extract and filter formats for a better UI
    raw_formats = info_data.get("formats") or []
    processed_formats = []
    
    # 1. Inject Virtual MP3 Options (Always available via our worker conversion)
    processed_formats.append({
        "format_id": "mp3",
        "resolution": "Audio (MP3)",
        "label": "High Quality MP3",
        "ext": "mp3",
        "type": "audio",
        "filesize": 0,
        "note": "320kbps",
        "priority": 10
    })

    # 2. Extract and Categorize Real Formats
    for f in raw_formats:
        vcodec = f.get("vcodec") or "none"
        acodec = f.get("acodec") or "none"
        ext = f.get("ext", "")
        height = f.get("height")
        
        # We only really care about MP4 for the UI to keep it simple, 
        # as we merge/convert to MP4 anyway.
        if vcodec != "none" and ext != "mp4":
            continue
            
        res_val = height if height else 0
        if res_val == 0: continue # Skip mystery resolutions
        
        label = f"{res_val}p"
        if res_val >= 2160: label += " (4K)"
        elif res_val >= 1080: label += " (Full HD)"
        elif res_val >= 720: label += " (HD)"

        processed_formats.append({
            "format_id": f.get("format_id"),
            "resolution": label,
            "res_val": res_val,
            "ext": ext,
            "type": "video",
            "filesize": f.get("filesize") or f.get("filesize_approx") or 0,
            "tbr": f.get("tbr") or 0,
            "priority": 5
        })

    # 3. Deduplicate Video by Resolution (Keep best bitrate)
    unique_video: dict[int, Any] = {}
    final_list = []
    
    # Add the MP3 first
    final_list.append(processed_formats[0])

    for f in processed_formats:
        if f["type"] == "audio": continue
        
        res = f["res_val"]
        if res not in unique_video or (f.get("tbr") or 0) > (unique_video[res].get("tbr") or 0):
            unique_video[res] = f

    # 4. Sort and Add Video Formats
    sorted_res = sorted(unique_video.keys(), reverse=True)
    for res in sorted_res:
        final_list.append(unique_video[res])

    # 5. Fallback for non-YouTube platforms (TikTok/FB) that might not have 'height'
    if len(final_list) <= 1: # Only MP3 is there
        for f in raw_formats:
            if f.get("vcodec") != "none":
                final_list.append({
                    "format_id": "best",
                    "resolution": "Video (Best)",
                    "label": "High Quality Video",
                    "ext": "mp4",
                    "type": "video",
                    "filesize": f.get("filesize") or f.get("filesize_approx") or 0,
                    "priority": 1
                })
                break

    return {
        "is_playlist": False,
        "title": info_data.get("title"),
        "thumbnail": info_data.get("thumbnail"),
        "url": url,
        "formats": final_list,
    }


def download_worker(task_id: str, url: str, format_id: str):
    file_path_template = f"{DOWNLOAD_DIR}/%(title)s_{task_id}.%(ext)s"
    _ansi = re.compile(r"\x1b\[[0-9;]*m")

    def my_hook(d):
        if download_progress.get(task_id, {}).get("cancelled"):
            # Raising an exception is the standard way to stop yt-dlp from a hook
            raise Exception("Download cancelled by user")

        if d["status"] == "downloading":
            raw_pct = _ansi.sub("", d.get("_percent_str", "0.0%")).replace("%", "").strip()
            try:
                percent = float(raw_pct)
            except ValueError:
                percent = 0.0
            
            # Update only if not cancelled to avoid race conditions
            if not download_progress.get(task_id, {}).get("cancelled"):
                download_progress[task_id].update({
                    "status": "downloading",
                    "percent": percent,
                    "speed": _ansi.sub("", d.get("_speed_str", "N/A")),
                    "eta": _ansi.sub("", d.get("_eta_str", "N/A")),
                })
        elif d["status"] == "finished":
            download_progress[task_id].update({
                "status": "finished",
                "percent": 100.0,
                "filename": d.get("filename"),
            })

    def post_hook(d):
        if download_progress.get(task_id, {}).get("cancelled"):
            raise Exception("Download cancelled by user")
        
        if d["status"] == "started":
            download_progress[task_id].update({"status": "processing"})

    # Determine if this platform uses pre-merged streams
    merged = is_merged_stream_url(url)

    # Base common options
    ydl_opts = {
        **BASE_YDL_OPTS,
        "outtmpl": file_path_template,
        "progress_hooks": [my_hook],
        "postprocessor_hooks": [post_hook],
    }

    if format_id in ("mp3", "bestaudio"):
        # Audio extraction
        ydl_opts.update({
            "format": "bestaudio/best",
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
            }],
        })
    elif merged or format_id in ("best", ""):
        # Merged-stream platform OR generic "best" — don't combine streams
        ydl_opts.update({
            "format": "best",
            "merge_output_format": "mp4",
        })
    else:
        # YouTube-style: combine selected video stream with best audio
        ydl_opts.update({
            "format": f"{format_id}+bestaudio/best",
            "merge_output_format": "mp4",
        })

    try:
        print(f"[DEBUG] Starting task {task_id} for URL {url}")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
            
        # Ensure status is marked as finished when completely done (including post-processing)
        if not download_progress.get(task_id, {}).get("cancelled"):
            download_progress[task_id].update({
                "status": "finished",
                "percent": 100.0,
            })
            print(f"[DEBUG] Task {task_id} is completely finished")
    except Exception as e:
        error_msg = str(e)
        print(f"[DEBUG] Task {task_id} stopped with: {error_msg}")
        
        status = "cancelled" if "cancelled by user" in error_msg.lower() else "error"
        download_progress[task_id].update({
            "status": status,
            "error": error_msg,
        })
        
        # Cleanup partial files if cancelled
        if status == "cancelled":
            # yt-dlp usually leaves .part files
            import time
            time.sleep(1) # Wait a bit for file handles to close
            for f in os.listdir(DOWNLOAD_DIR):
                if task_id in f:
                    try:
                        os.remove(os.path.join(DOWNLOAD_DIR, f))
                        print(f"[DEBUG] Removed partial file: {f}")
                    except Exception as clean_err:
                        print(f"[DEBUG] Cleanup error: {clean_err}")


@app.post("/start_download")
async def start_download(
    background_tasks: BackgroundTasks,
    url: str = Form(...),
    format_id: str = Form("best"),
):
    task_id = str(uuid.uuid4())
    download_progress[task_id] = {"status": "starting", "percent": 0.0, "cancelled": False}
    background_tasks.add_task(download_worker, task_id, url, format_id)
    return {"task_id": task_id}


@app.post("/stop_download/{task_id}")
async def stop_download(task_id: str):
    if task_id in download_progress:
        download_progress[task_id]["cancelled"] = True
        return {"status": "cancelling"}
    return JSONResponse(status_code=404, content={"error": "Task not found"})


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
