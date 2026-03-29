let currentUrl = '';
const activeTasks = new Map(); // Store task_id -> { status, percent, title }
let pollInterval = null;

// Persistence: Load tasks from localStorage on startup
const STORAGE_KEY = 'dload_active_tasks';

function saveTasks() {
    const tasks = [];
    for (const [taskId, info] of activeTasks.entries()) {
        tasks.push({ taskId, ...info });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function loadTasks() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        try {
            const tasks = JSON.parse(stored);
            tasks.forEach(task => {
                const { taskId, ...info } = task;
                // Only load if it was still active
                if (info.status !== 'finished' && info.status !== 'error' && info.status !== 'cancelled') {
                    activeTasks.set(taskId, info);
                    createTaskUI(taskId, info.title);
                }
            });
            if (activeTasks.size > 0) {
                updateActiveCount();
                startPolling();
            }
        } catch (e) {
            console.error("Failed to load tasks from storage", e);
        }
    }
}

// Request notification permission on load
if ("Notification" in window) {
    if (Notification.permission !== "granted" && Notification.permission !== "denied") {
        Notification.requestPermission();
    }
}

function notifyUser(title, body) {
    if ("Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, icon: "/static/favicon.ico" });
    }
}

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
    
    document.getElementById('result-card').classList.add('hidden');
    document.getElementById('playlist-card').classList.add('hidden');
    document.getElementById('empty-state').classList.add('hidden');
    document.getElementById('error-message').classList.add('hidden');
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
        toggleEmptyState();
    } finally {
        document.getElementById('loading').classList.add('hidden');
        fetchBtn.classList.remove('loading');
    }
}

function toggleEmptyState() {
    const url = document.getElementById('url').value.trim();
    const emptyState = document.getElementById('empty-state');
    const resultCard = document.getElementById('result-card');
    const playlistCard = document.getElementById('playlist-card');
    
    if (!url && resultCard.classList.contains('hidden') && playlistCard.classList.contains('hidden')) {
        emptyState.classList.remove('hidden');
    } else {
        emptyState.classList.add('hidden');
    }
}

function renderSingleVideo(data) {
    document.getElementById('result-card').classList.remove('hidden');
    const previewContainer = document.getElementById('video-preview-container');
    previewContainer.innerHTML = '';
    
    if (data.url && (data.url.includes('youtube.com') || data.url.includes('youtu.be'))) {
        let videoId = getYoutubeId(data.url);
        if (videoId) {
            previewContainer.innerHTML = `<iframe src="https://www.youtube.com/embed/${videoId}" allowfullscreen title="Preview"></iframe>`;
        } else {
            previewContainer.innerHTML = `<img id="video-thumb" src="${data.thumbnail || 'https://via.placeholder.com/320x180?text=No+Thumbnail'}" alt="Thumbnail">`;
        }
    } else {
        previewContainer.innerHTML = `<img id="video-thumb" src="${data.thumbnail || 'https://via.placeholder.com/320x180?text=No+Thumbnail'}" alt="Thumbnail">`;
    }

    document.getElementById('video-title').textContent = data.title || 'Unknown Title';
    const qualitiesContainer = document.getElementById('qualities-container');
    qualitiesContainer.innerHTML = '';
    
    if (data.formats && data.formats.length > 0) {
        data.formats.forEach(format => {
            const isVideo = format.type === 'video';
            const icon = isVideo ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-music"></i>';
            const sizeText = format.filesize ? formatBytes(format.filesize) : (isVideo ? '-- MB' : 'High Quality');
            const extLabel = format.ext ? `(.${format.ext})` : "";
            
            const btn = document.createElement('div');
            btn.className = 'quality-row';
            btn.innerHTML = `
                <div class="quality-info">
                    <span class="quality-type-icon">${icon}</span>
                    <span>${format.resolution} ${extLabel}</span>
                    <span class="quality-size badge">${sizeText}</span>
                </div>
                <button class="quality-btn" onclick="startDownload('${data.url}', '${format.format_id || ''}', '${(data.title || 'Video').replace(/'/g, "\\'")}')">
                    <i class="fa-solid fa-download"></i> Download
                </button>
            `;
            qualitiesContainer.appendChild(btn);
        });
    } else {
        // Absolute fallback if everything fails
        qualitiesContainer.innerHTML = `
            <div class="quality-row">
                <div class="quality-info"><i class="fa-solid fa-video"></i> Video (Best)</div>
                <button class="quality-btn" onclick="startDownload('${data.url}', 'best', '${(data.title || 'Video').replace(/'/g, "\\'")}')">Download</button>
            </div>
            <div class="quality-row">
                <div class="quality-info"><i class="fa-solid fa-music"></i> Audio (MP3)</div>
                <button class="quality-btn" onclick="startDownload('${data.url}', 'mp3', '${(data.title || 'Video').replace(/'/g, "\\'")}')">Download</button>
            </div>
        `;
    }
}

let lastPlaylistData = null;
function renderPlaylist(data) {
    lastPlaylistData = data;
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
                    <div class="playlist-item-actions">
                        <button class="playlist-item-btn" id="load-btn-${idx}" onclick="loadPlaylistItemFormats('${entry.url}', ${idx})">
                            <i class="fa-solid fa-list-ul"></i> Options
                        </button>
                        <button class="playlist-item-btn quick-mp3-btn" onclick="startDownload('${entry.url}', 'mp3', '${(entry.title || 'Audio').replace(/'/g, "\\'")}')">
                            <i class="fa-solid fa-music"></i> MP3
                        </button>
                    </div>
                </div>
            </div>
            <div id="playlist-formats-${idx}" class="playlist-formats-container hidden"></div>
        `;
        container.appendChild(item);
    });
}

function downloadAll() {
    if (!lastPlaylistData || !lastPlaylistData.entries) return;
    const entries = lastPlaylistData.entries;
    let count = 0;
    entries.forEach(entry => {
        if (entry.url) {
            setTimeout(() => {
                startDownload(entry.url, 'mp3', entry.title || 'Audio');
            }, count * 500);
            count++;
        }
    });
    showError(`Started ${count} background downloads. Check active downloads below.`);
    document.getElementById('error-message').style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
    document.getElementById('error-message').style.color = '#3b82f6';
    document.getElementById('error-message').style.borderColor = 'rgba(59, 130, 246, 0.3)';
}

async function loadPlaylistItemFormats(url, idx) {
    const btn = document.getElementById(`load-btn-${idx}`);
    const container = document.getElementById(`playlist-formats-${idx}`);
    
    if (!container.classList.contains('hidden')) {
        container.classList.add('hidden');
        btn.innerHTML = '<i class="fa-solid fa-list-ul"></i> Options';
        return;
    }
    
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
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
                const sizeText = format.filesize ? formatBytes(format.filesize) : (isVideo ? '-- MB' : 'High Quality');
                const extLabel = format.ext ? `(.${format.ext})` : "";
                
                const row = document.createElement('div');
                row.className = 'quality-row inline-format-row';
                row.innerHTML = `
                    <div class="quality-info">
                        <span class="quality-type-icon">${icon}</span>
                        <span>${format.resolution} ${extLabel}</span>
                        <span class="quality-size badge">${sizeText}</span>
                    </div>
                    <button class="quality-btn inline-btn" onclick="startDownload('${data.url}', '${format.format_id || ''}', '${(data.title || 'Video').replace(/'/g, "\\'")}')">
                        <i class="fa-solid fa-download"></i>
                    </button>
                `;
                container.appendChild(row);
            });
        } else {
            container.innerHTML = '<p style="padding:1rem;color:var(--text-muted)">No specific formats found.</p>';
        }
        
        container.classList.remove('hidden');
        btn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Hide';
    } catch (e) {
        console.error(e);
        btn.innerHTML = '<i class="fa-solid fa-list-ul"></i> Options';
        container.innerHTML = `<p style="padding:0.75rem 1rem;color:#f87171;font-size:0.85rem"><i class="fa-solid fa-triangle-exclamation"></i> ${e.message || 'Failed to load options.'}</p>`;
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

function startPolling() {
    if (!pollInterval) {
        pollInterval = setInterval(pollAllTasks, 1000);
    }
}

async function startDownload(url, format_id, title) {
    document.getElementById('downloads-container').classList.remove('hidden');
    
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
        const taskId = data.task_id;
        
        createTaskUI(taskId, title);
        activeTasks.set(taskId, { status: 'starting', percent: 0, title: title });
        saveTasks();
        updateActiveCount();
        
        notifyUser("Download Started", `Starting download for: ${title}`);
        startPolling();
        
    } catch (err) {
        console.error(err);
        showError('Could not start download for: ' + title);
    }
}

function createTaskUI(taskId, title) {
    const list = document.getElementById('tasks-list');
    if (document.getElementById(`task-${taskId}`)) return; // Already exists

    const taskEl = document.createElement('div');
    taskEl.className = 'task-item';
    taskEl.id = `task-${taskId}`;
    taskEl.innerHTML = `
        <div class="task-info">
            <span class="task-title" title="${title}">${title}</span>
            <div class="task-actions">
                <span class="task-percent" id="task-percent-${taskId}">0%</span>
                <button class="stop-btn" id="stop-btn-${taskId}" onclick="stopDownload('${taskId}')">
                    <i class="fa-solid fa-stop"></i> Stop
                </button>
            </div>
        </div>
        <div class="progress-bar-bg small">
            <div class="progress-bar-fill" id="task-fill-${taskId}"></div>
        </div>
        <div class="task-stats">
            <span id="task-status-${taskId}">Starting...</span>
            <span id="task-speed-${taskId}">--</span>
            <span id="task-eta-${taskId}">--</span>
        </div>
    `;
    list.prepend(taskEl);
    document.getElementById('downloads-container').classList.remove('hidden');
}

async function stopDownload(taskId) {
    console.log("Stopping task:", taskId);
    try {
        const response = await fetch(`/stop_download/${taskId}`, { method: 'POST' });
        if (response.ok) {
            const task = activeTasks.get(taskId);
            if (task) task.status = 'cancelling';
            saveTasks();
            
            const status = document.getElementById(`task-status-${taskId}`);
            if (status) status.textContent = 'Stopping...';
            const stopBtn = document.getElementById(`stop-btn-${taskId}`);
            if (stopBtn) stopBtn.classList.add('hidden');
        } else {
            const err = await response.json().catch(() => ({}));
            const msg = err.error || err.detail || JSON.stringify(err);
            console.error("Stop failed:", msg, "Full error:", err);
            showError("Stop failed: " + msg);
        }
    } catch (err) {
        console.error("Stop error:", err);
        showError("Stop error: " + err.message);
    }
}

async function pollAllTasks() {
    if (activeTasks.size === 0) {
        clearInterval(pollInterval);
        pollInterval = null;
        return;
    }
    
    for (const [taskId, taskInfo] of activeTasks.entries()) {
        try {
            const res = await fetch(`/progress/${taskId}`);
            const data = await res.json();
            
            const fill = document.getElementById(`task-fill-${taskId}`);
            const pct = document.getElementById(`task-percent-${taskId}`);
            const status = document.getElementById(`task-status-${taskId}`);
            const speed = document.getElementById(`task-speed-${taskId}`);
            const eta = document.getElementById(`task-eta-${taskId}`);
            const stopBtn = document.getElementById(`stop-btn-${taskId}`);
            
            if (!fill) {
                // If element doesn't exist but task is active (e.g. after refresh), recreate UI
                createTaskUI(taskId, taskInfo.title);
                continue;
            }

            if (data.status === 'downloading' || data.status === 'starting' || data.status === 'processing') {
                const p = data.percent || 0;
                fill.style.width = `${p}%`;
                pct.textContent = `${p}%`;
                status.textContent = data.status === 'starting' ? 'Preparing...' : 
                                  data.status === 'processing' ? 'Processing...' : 'Downloading...';
                speed.textContent = data.speed || '--';
                eta.textContent = data.eta || '--';
                
                // Update local state and save
                if (taskInfo.status !== data.status || taskInfo.percent !== p) {
                    taskInfo.status = data.status;
                    taskInfo.percent = p;
                    saveTasks();
                }
            } else if (data.status === 'finished') {
                fill.style.width = '100%';
                pct.textContent = '100%';
                status.innerHTML = `<a href="/serve_file/${taskId}" class="task-download-link"><i class="fa-solid fa-check-double"></i> Save File</a>`;
                speed.textContent = '--';
                eta.textContent = '0s';
                if (stopBtn) stopBtn.classList.add('hidden');
                
                notifyUser("Download Finished", `Finished downloading: ${taskInfo.title}`);
                window.location.href = `/serve_file/${taskId}`;
                
                activeTasks.delete(taskId);
                saveTasks();
                updateActiveCount();
                setTimeout(() => {
                    const el = document.getElementById(`task-${taskId}`);
                    if (el) el.style.opacity = '0.5';
                }, 5 * 60 * 1000); // 5 minutes
            } else if (data.status === 'cancelled' || data.status === 'error') {
                status.textContent = data.status === 'cancelled' ? 'Cancelled' : 'Error';
                status.style.color = '#ef4444';
                if (stopBtn) stopBtn.classList.add('hidden');
                activeTasks.delete(taskId);
                saveTasks();
                updateActiveCount();
            } else if (data.status === 'not_found') {
                // Task probably died or stayed for too long on server
                activeTasks.delete(taskId);
                saveTasks();
                updateActiveCount();
                const el = document.getElementById(`task-${taskId}`);
                if (el) el.remove();
            }
        } catch (err) {
            console.error("Poll error for " + taskId, err);
        }
    }
}

function updateActiveCount() {
    const el = document.getElementById('active-count');
    if (el) el.textContent = activeTasks.size;
}

function showError(msg) {
    const errorEl = document.getElementById('error-message');
    document.getElementById('error-text').textContent = msg;
    errorEl.classList.remove('hidden');
    
    errorEl.style.backgroundColor = 'rgba(239, 68, 68, 0.1)';
    errorEl.style.color = '#ef4444';
    errorEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    
    setTimeout(() => {
        errorEl.classList.add('hidden');
    }, 10000);
}

document.getElementById('url').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        fetchInfo();
    }
});

loadTasks();
toggleEmptyState();