let currentUrl = '';
let currentTaskId = null;
let pollInterval = null;

function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return 'Unknown Size';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function fetchInfo() {
    const urlInput = document.getElementById('url');
    const url = urlInput.value.trim();
    
    if (!url) {
        showError('Please enter a valid URL');
        return;
    }
    
    currentUrl = url;
    
    // UI states reset
    document.getElementById('result-card').classList.add('hidden');
    document.getElementById('playlist-card').classList.add('hidden');
    document.getElementById('error-message').classList.add('hidden');
    document.getElementById('progress-container').classList.add('hidden');
    document.getElementById('loading').classList.remove('hidden');
    
    const fetchBtn = document.getElementById('fetch-btn');
    fetchBtn.classList.add('loading');
    
    try {
        const formData = new FormData();
        formData.append('url', url);
        
        const response = await fetch('/info', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to fetch video information');
        }
        
        const data = await response.json();
        
        if (data.is_playlist) {
            renderPlaylist(data);
        } else {
            renderSingleVideo(data);
        }
        
    } catch (err) {
        console.error(err);
        showError(err.message || 'Failed to fetch video info. Please make sure the link is valid and try again.');
    } finally {
        document.getElementById('loading').classList.add('hidden');
        fetchBtn.classList.remove('loading');
    }
}

function renderSingleVideo(data) {
    document.getElementById('result-card').classList.remove('hidden');
    
    // Set Preview
    const previewContainer = document.getElementById('video-preview-container');
    previewContainer.innerHTML = '';
    
    // Attempt to make an iframe preview if Youtube
    if (data.url && (data.url.includes('youtube.com') || data.url.includes('youtu.be'))) {
        let videoId = getYoutubeId(data.url);
        if (videoId) {
            previewContainer.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}" allowfullscreen></iframe>`;
        } else {
            previewContainer.innerHTML = `<img id="video-thumb" src="${data.thumbnail || 'https://via.placeholder.com/320x180?text=No+Thumbnail'}" alt="Thumbnail">`;
        }
    } else {
        previewContainer.innerHTML = `<img id="video-thumb" src="${data.thumbnail || 'https://via.placeholder.com/320x180?text=No+Thumbnail'}" alt="Thumbnail">`;
    }

    document.getElementById('video-title').textContent = data.title || 'Unknown Title';
    
    // Render Qualities
    const qualitiesContainer = document.getElementById('qualities-container');
    qualitiesContainer.innerHTML = '';
    
    if (data.formats && data.formats.length > 0) {
        data.formats.forEach(format => {
            const isVideo = format.type === 'video';
            const icon = isVideo ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-music"></i>';
            const resText = format.resolution || (isVideo ? 'Video' : 'Audio');
            const sizeText = formatBytes(format.filesize);
            
            const btn = document.createElement('div');
            btn.className = 'quality-row';
            btn.innerHTML = `
                <div class="quality-info">
                    <span class="quality-type-icon">${icon}</span>
                    <span>${resText} (.${format.ext})</span>
                    <span class="quality-size badge">${sizeText}</span>
                </div>
                <button class="quality-btn" onclick="startDownload('${data.url}', '${format.format_id || ''}')">
                    <i class="fa-solid fa-download"></i> Download
                </button>
            `;
            qualitiesContainer.appendChild(btn);
        });
    } else {
        // Fallback generic buttons
        qualitiesContainer.innerHTML = `
            <div class="quality-row">
                <div class="quality-info"><i class="fa-solid fa-video"></i> Best Video</div>
                <button class="quality-btn" onclick="startDownload('${data.url}', 'best')">Download</button>
            </div>
            <div class="quality-row">
                <div class="quality-info"><i class="fa-solid fa-music"></i> Audio (MP3)</div>
                <button class="quality-btn" onclick="startDownload('${data.url}', 'mp3')">Download</button>
            </div>
        `;
    }
}

function renderPlaylist(data) {
    document.getElementById('playlist-card').classList.remove('hidden');
    document.getElementById('playlist-title').textContent = data.title || 'Playlist';
    
    const container = document.getElementById('playlist-items');
    container.innerHTML = '';
    
    data.entries.forEach((entry, idx) => {
        const item = document.createElement('div');
        item.className = 'playlist-item-wrapper';
        const thumb = entry.thumbnail || 'https://via.placeholder.com/120x67?text=No+Thumb';
        item.innerHTML = `
            <div class="playlist-item">
                <img src="${thumb}" class="playlist-item-thumb" alt="Thumb">
                <div class="playlist-item-info">
                    <h3 class="playlist-item-title">${entry.title || 'Unknown Video'}</h3>
                    <button class="playlist-item-btn" id="load-btn-${idx}" onclick="loadPlaylistItemFormats('${entry.url}', ${idx})">Load Options</button>
                </div>
            </div>
            <div id="playlist-formats-${idx}" class="playlist-formats-container hidden"></div>
        `;
        container.appendChild(item);
    });
}

async function loadPlaylistItemFormats(url, idx) {
    const btn = document.getElementById(`load-btn-${idx}`);
    const container = document.getElementById(`playlist-formats-${idx}`);
    
    if (!container.classList.contains('hidden')) {
        // Toggle hide
        container.classList.add('hidden');
        btn.textContent = 'Load Options';
        return;
    }
    
    btn.textContent = 'Loading...';
    btn.disabled = true;
    
    try {
        const formData = new FormData();
        formData.append('url', url);
        const response = await fetch('/info', { method: 'POST', body: formData });
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || 'Failed to fetch video info');
        }
        const data = await response.json();
        
        container.innerHTML = '';
        if (data.formats && data.formats.length > 0) {
            data.formats.forEach(format => {
                const isVideo = format.type === 'video';
                const icon = isVideo ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-music"></i>';
                const resText = format.resolution || (isVideo ? 'Video' : 'Audio');
                const sizeText = formatBytes(format.filesize);
                
                const row = document.createElement('div');
                row.className = 'quality-row inline-format-row';
                row.innerHTML = `
                    <div class="quality-info">
                        <span class="quality-type-icon">${icon}</span>
                        <span>${resText} (.${format.ext})</span>
                        <span class="quality-size badge">${sizeText}</span>
                    </div>
                    <button class="quality-btn inline-btn" onclick="startDownload('${data.url}', '${format.format_id || ''}')">
                        <i class="fa-solid fa-download"></i>
                    </button>
                `;
                container.appendChild(row);
            });
        } else {
            container.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">No specific formats found.</p>';
        }
        
        container.classList.remove('hidden');
        btn.textContent = 'Hide Options';
    } catch (e) {
        console.error(e);
        btn.textContent = 'Load Options';
        container.innerHTML = `<p style="padding:0.75rem 1rem;color:#f87171;font-size:0.85rem"><i class="fa-solid fa-triangle-exclamation"></i> ${e.message || 'Failed to load options. Try again.'}</p>`;
        container.classList.remove('hidden');
    } finally {
        btn.disabled = false;
    }
}

function getYoutubeId(url) {
    var regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    var match = url.match(regExp);
    if (match && match[2].length == 11) {
        return match[2];
    }
    return null;
}

async function startDownload(url, format_id) {
    document.getElementById('progress-container').classList.remove('hidden');
    // Hide single video qualities during download if visible
    const qualitiesContainer = document.getElementById('qualities-container');
    if (qualitiesContainer) qualitiesContainer.style.display = 'none';
    
    // reset progress UI
    updateProgressUI(0, "Starting...", "--", "--");
    
    try {
        const formData = new FormData();
        formData.append('url', url);
        formData.append('format_id', format_id);
        
        const response = await fetch('/start_download', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) throw new Error('Failed to start download');
        
        const data = await response.json();
        currentTaskId = data.task_id;
        
        // Start polling
        if (pollInterval) clearInterval(pollInterval);
        pollInterval = setInterval(pollProgress, 1000);
        
    } catch (err) {
        console.error(err);
        showError('Download error');
    }
}

async function pollProgress() {
    if (!currentTaskId) return;
    
    try {
        const res = await fetch(`/progress/${currentTaskId}`);
        const data = await res.json();
        
        if (data.status === 'downloading' || data.status === 'starting') {
            updateProgressUI(data.percent || 0, "Downloading...", data.speed || '--', data.eta || '--');
        } else if (data.status === 'finished') {
            updateProgressUI(100, "Done! Processing...", "--", "0s");
            clearInterval(pollInterval);
            pollInterval = null;
            triggerFileDownload(currentTaskId);
        } else if (data.status === 'error') {
            clearInterval(pollInterval);
            pollInterval = null;
            updateProgressUI(0, "Error", "--", "--");
            showError("Download failed: " + (data.error || 'Unknown error'));
            document.getElementById('qualities-container').style.display = 'block';
        }
    } catch (err) {
        console.error("Poll error", err);
    }
}

function updateProgressUI(percent, status, speed, eta) {
    document.getElementById('progress-bar-fill').style.width = `${percent}%`;
    document.getElementById('progress-percent').textContent = `${percent}%`;
    document.getElementById('progress-status').textContent = status;
    document.getElementById('progress-speed').textContent = `Speed: ${speed}`;
    document.getElementById('progress-eta').textContent = `ETA: ${eta}`;
}

async function triggerFileDownload(taskId) {
    // Show download trigger in case the browser blocks popup
    document.getElementById('progress-status').innerHTML = `<strong>Download Completed!</strong> <a href="/serve_file/${taskId}" target="_blank" style="color:var(--primary); text-decoration: underline; margin-left: 8px;">Click here if not downloading automatically</a>`;
    window.location.href = `/serve_file/${taskId}`;
    
    // reset after 5 seconds to allow downloading another
    setTimeout(() => {
        document.getElementById('progress-container').classList.add('hidden');
        document.getElementById('qualities-container').style.display = 'block';
    }, 5000);
}

function showError(msg) {
    const errorEl = document.getElementById('error-message');
    document.getElementById('error-text').textContent = msg;
    errorEl.classList.remove('hidden');
}

// Allow pressing Enter in the input field
document.getElementById('url').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        fetchInfo();
    }
});