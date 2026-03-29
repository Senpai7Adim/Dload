import requests
import time

BASE_URL = "http://localhost:8000"

def test_info_playlist():
    print("Testing /info with a search query (simulated playlist)...")
    resp = requests.post(f"{BASE_URL}/info", data={"url": "beethoven"})
    if resp.status_code == 200:
        data = resp.json()
        print(f"Success! Title: {data.get('title')}")
        print(f"Is Playlist: {data.get('is_playlist')}")
        entries = data.get('entries', [])
        print(f"Entries found: {len(entries)}")
        if entries:
            print(f"First entry title: {entries[0].get('title')}")
            print(f"First entry URL: {entries[0].get('url')}")
            return entries[0].get('url'), entries[0].get('title')
    else:
        print(f"Failed /info: {resp.status_code} - {resp.text}")
    return None, None

def test_download(url, title):
    if not url:
        return
    print(f"\nTesting /start_download for: {title}")
    resp = requests.post(f"{BASE_URL}/start_download", data={"url": url, "format_id": "mp3"})
    if resp.status_code == 200:
        task_id = resp.json().get("task_id")
        print(f"Success! Task ID: {task_id}")
        
        # Poll for progress
        for _ in range(10):
            time.sleep(2)
            p_resp = requests.get(f"{BASE_URL}/progress/{task_id}")
            p_data = p_resp.json()
            print(f"Progress: {p_data.get('status')} - {p_data.get('percent')}%")
            if p_data.get('status') in ['finished', 'error']:
                break
    else:
        print(f"Failed /start_download: {resp.status_code} - {resp.text}")

if __name__ == "__main__":
    url, title = test_info_playlist()
    if url:
        test_download(url, title)
