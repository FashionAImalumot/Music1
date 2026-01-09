/**
 * APP STATE & CONFIGURATION
 */
const DB_NAME = 'MusicPlayerDB';
const DB_VERSION = 1;

const state = {
    db: null,
    audioCtx: null,
    analyser: null,
    sourceNode: null,
    currentTrack: null,
    queue: [], 
    queueIndex: -1,
    isPlaying: false,
    activePlaylistId: null, // null means Library view
    visualizerRunning: false
};

// DOM Elements
const els = {
    fileInput: document.getElementById('file-upload'),
    libraryList: document.getElementById('library-list'),
    playlistList: document.getElementById('playlist-list'),
    btnCreatePlaylist: document.getElementById('btn-create-playlist'),
    playlistView: document.getElementById('active-playlist-view'),
    playlistTracks: document.getElementById('playlist-track-list'),
    playlistNav: document.getElementById('playlist-list'),
    audio: document.getElementById('audio-element'),
    canvas: document.getElementById('visualizer'),
    npTitle: document.getElementById('np-title'),
    npArtist: document.getElementById('np-artist'),
    btnPrev: document.getElementById('btn-prev'),
    btnNext: document.getElementById('btn-next'),
    // Active Playlist Controls
    lblPlaylistName: document.getElementById('current-playlist-name'),
    btnPlayPlaylist: document.getElementById('btn-play-playlist'),
    btnRenamePlaylist: document.getElementById('btn-rename-playlist'),
    btnDeletePlaylist: document.getElementById('btn-delete-playlist'),
    btnClosePlaylist: document.getElementById('btn-close-playlist'),
    // Modal
    modal: document.getElementById('modal-overlay'),
    modalList: document.getElementById('modal-playlist-list'),
    btnCloseModal: document.getElementById('btn-close-modal')
};

/**
 * INDEXED DB HANDLER
 */
async function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('tracks')) {
                db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains('playlists')) {
                db.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
            }
        };

        request.onsuccess = (event) => {
            state.db = event.target.result;
            resolve(state.db);
        };

        request.onerror = (event) => reject('DB Error: ' + event.target.errorCode);
    });
}

function dbAction(storeName, mode, callback) {
    const tx = state.db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return callback(store);
}

/**
 * CORE FUNCTIONS: TRACKS & DELETION
 */
async function loadLibrary() {
    return new Promise((resolve) => {
        const tracks = [];
        dbAction('tracks', 'readonly', (store) => {
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    tracks.push(cursor.value);
                    cursor.continue();
                } else {
                    renderLibrary(tracks);
                    resolve(tracks);
                }
            };
        });
    });
}

async function saveFiles(files) {
    const promises = Array.from(files).map(file => {
        return new Promise((resolve, reject) => {
            // Robust check for mime type, sometimes missing on mobile uploads
            const fileType = file.type || 'audio/mp3'; 
            
            const track = {
                name: file.name.replace(/\.[^/.]+$/, ""),
                type: fileType,
                size: file.size,
                data: file, // Store File/Blob
                addedAt: Date.now()
            };
            dbAction('tracks', 'readwrite', (store) => {
                const req = store.add(track);
                req.onsuccess = () => resolve();
                req.onerror = () => reject();
            });
        });
    });

    await Promise.all(promises);
    loadLibrary();
}

/**
 * DELETION LOGIC (Global)
 */
async function deleteTrack(trackId) {
    if (!confirm("Permanently delete this track from library and all playlists?")) return;

    if (state.currentTrack && state.currentTrack.id === trackId) {
        els.audio.pause();
        els.audio.src = "";
        els.npTitle.textContent = "Select a track";
        state.currentTrack = null;
        state.isPlaying = false;
    }

    await new Promise((resolve) => {
        dbAction('tracks', 'readwrite', (store) => {
            store.delete(trackId).onsuccess = () => resolve();
        });
    });

    await new Promise((resolve) => {
        dbAction('playlists', 'readwrite', (store) => {
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const pl = cursor.value;
                    if (pl.trackIds.includes(trackId)) {
                        pl.trackIds = pl.trackIds.filter(id => id !== trackId);
                        cursor.update(pl);
                    }
                    cursor.continue();
                } else {
                    resolve();
                }
            };
        });
    });

    updateUIAfterDelete();
}

function updateUIAfterDelete() {
    loadLibrary();
    loadPlaylists();
    if (state.activePlaylistId) {
        openPlaylist(state.activePlaylistId);
    }
}

/**
 * CORE FUNCTIONS: PLAYLISTS
 */
async function loadPlaylists() {
    return new Promise((resolve) => {
        const playlists = [];
        dbAction('playlists', 'readonly', (store) => {
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    playlists.push(cursor.value);
                    cursor.continue();
                } else {
                    renderPlaylists(playlists);
                    resolve(playlists);
                }
            };
        });
    });
}

function createPlaylist() {
    const name = prompt("Enter playlist name:");
    if (!name) return;
    
    const playlist = {
        name: name,
        createdAt: Date.now(),
        trackIds: []
    };

    dbAction('playlists', 'readwrite', (store) => {
        store.add(playlist).onsuccess = () => loadPlaylists();
    });
}

function deletePlaylist(id) {
    if(!confirm("Delete this playlist?")) return;
    dbAction('playlists', 'readwrite', (store) => {
        store.delete(id).onsuccess = () => {
            els.playlistView.classList.add('hidden');
            els.playlistNav.classList.remove('hidden');
            state.activePlaylistId = null;
            loadPlaylists();
        };
    });
}

function renamePlaylist(id) {
    const newName = prompt("New name:");
    if (!newName) return;

    dbAction('playlists', 'readwrite', (store) => {
        store.get(id).onsuccess = (e) => {
            const pl = e.target.result;
            pl.name = newName;
            store.put(pl).onsuccess = () => {
                loadPlaylists();
                els.lblPlaylistName.textContent = newName;
            };
        };
    });
}

function addToPlaylist(trackId) {
    els.modal.classList.remove('hidden');
    dbAction('playlists', 'readonly', (store) => {
        const req = store.getAll();
        req.onsuccess = (e) => {
            const playlists = e.target.result;
            els.modalList.innerHTML = '';
            playlists.forEach(pl => {
                const li = document.createElement('li');
                li.textContent = pl.name;
                li.onclick = () => {
                    if(!pl.trackIds.includes(trackId)) {
                        pl.trackIds.push(trackId);
                        dbAction('playlists', 'readwrite', (s) => {
                            s.put(pl).onsuccess = () => {
                                els.modal.classList.add('hidden');
                                if (state.activePlaylistId === pl.id) openPlaylist(pl.id);
                            };
                        });
                    } else {
                        alert("Track already in playlist");
                        els.modal.classList.add('hidden');
                    }
                };
                els.modalList.appendChild(li);
            });
        };
    });
}

function removeFromPlaylist(playlistId, trackId) {
    dbAction('playlists', 'readwrite', (store) => {
        store.get(playlistId).onsuccess = (e) => {
            const pl = e.target.result;
            pl.trackIds = pl.trackIds.filter(id => id !== trackId);
            store.put(pl).onsuccess = () => openPlaylist(playlistId);
        };
    });
}

function openPlaylist(id) {
    state.activePlaylistId = id;
    
    dbAction('playlists', 'readonly', (store) => {
        store.get(id).onsuccess = (e) => {
            const playlist = e.target.result;
            if(!playlist) return;

            els.playlistNav.classList.add('hidden');
            els.playlistView.classList.remove('hidden');
            els.lblPlaylistName.textContent = playlist.name;

            els.btnDeletePlaylist.onclick = () => deletePlaylist(id);
            els.btnRenamePlaylist.onclick = () => renamePlaylist(id);
            
            dbAction('tracks', 'readonly', (tStore) => {
                tStore.getAll().onsuccess = (evt) => {
                    const allTracks = evt.target.result;
                    const playlistTracks = playlist.trackIds
                        .map(tid => allTracks.find(t => t.id === tid))
                        .filter(t => t); 

                    renderPlaylistTracks(playlistTracks, playlist.id);
                    
                    els.btnPlayPlaylist.onclick = () => {
                        playQueue(playlistTracks, 0);
                    };
                };
            });
        };
    });
}

/**
 * UI RENDERING
 */
function renderLibrary(tracks) {
    els.libraryList.innerHTML = '';
    tracks.forEach(track => {
        const li = document.createElement('li');
        li.className = 'track-item';
        
        li.innerHTML = `
            <div class="track-main">
                <div class="track-name">${track.name}</div>
                <div class="track-meta">${(track.size / 1024 / 1024).toFixed(2)} MB</div>
            </div>
            <div class="track-actions">
                <button class="icon-btn play-btn" title="Play">▶</button>
                <button class="icon-btn add-btn" title="Add to Playlist">+</button>
                <button class="icon-btn delete-btn" title="Delete from Disk">✕</button>
            </div>
        `;
        
        li.querySelector('.play-btn').onclick = (e) => {
            e.stopPropagation();
            playQueue(tracks, tracks.indexOf(track));
        };

        li.querySelector('.add-btn').onclick = (e) => {
            e.stopPropagation();
            addToPlaylist(track.id);
        };

        li.querySelector('.delete-btn').onclick = (e) => {
            e.stopPropagation();
            deleteTrack(track.id);
        };

        els.libraryList.appendChild(li);
    });
}

function renderPlaylists(playlists) {
    els.playlistList.innerHTML = '';
    playlists.forEach(pl => {
        const li = document.createElement('li');
        li.className = 'playlist-item';
        li.innerHTML = `<span>${pl.name}</span> <span class="track-meta">${pl.trackIds.length} songs</span>`;
        li.onclick = () => openPlaylist(pl.id);
        els.playlistList.appendChild(li);
    });
}

function renderPlaylistTracks(tracks, playlistId) {
    els.playlistTracks.innerHTML = '';
    if(tracks.length === 0) {
        els.playlistTracks.innerHTML = '<li style="padding:10px; color:#666">No tracks yet. Add from Library.</li>';
        return;
    }
    tracks.forEach((track, index) => {
        const li = document.createElement('li');
        li.className = 'track-item';
        li.innerHTML = `
            <div class="track-main">
                <div class="track-name">${track.name}</div>
            </div>
            <div class="track-actions">
                <button class="icon-btn play-btn" title="Play">▶</button>
                <button class="icon-btn danger" title="Remove from Playlist">-</button>
                <button class="icon-btn delete-btn" title="Delete from Disk">✕</button>
            </div>
        `;
        
        li.querySelector('.play-btn').onclick = (e) => {
            e.stopPropagation();
            playQueue(tracks, index);
        };

        li.querySelector('.danger').onclick = (e) => {
            e.stopPropagation();
            removeFromPlaylist(playlistId, track.id);
        };

        li.querySelector('.delete-btn').onclick = (e) => {
            e.stopPropagation();
            deleteTrack(track.id);
        };
        
        els.playlistTracks.appendChild(li);
    });
}

/**
 * AUDIO ENGINE
 */
function initAudioContext() {
    if (!state.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        state.audioCtx = new AudioContext();
        state.analyser = state.audioCtx.createAnalyser();
        state.analyser.fftSize = 256;
        
        state.sourceNode = state.audioCtx.createMediaElementSource(els.audio);
        state.sourceNode.connect(state.analyser);
        state.analyser.connect(state.audioCtx.destination);
        
        drawVisualizer();
    }
    if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume();
    }
}

function playQueue(queue, startIndex) {
    initAudioContext();
    state.queue = queue;
    state.queueIndex = startIndex;
    loadTrack(state.queue[state.queueIndex]);
}

function loadTrack(track) {
    if (!track) return;
    state.currentTrack = track;
    
    if (els.audio.src) URL.revokeObjectURL(els.audio.src);

    const fileUrl = URL.createObjectURL(track.data);
    els.audio.src = fileUrl;
    els.audio.play()
        .then(() => {
            state.isPlaying = true;
            updateMediaSession();
            updatePlayerUI();
        })
        .catch(e => console.error("Playback failed", e));
}

function updatePlayerUI() {
    els.npTitle.textContent = state.currentTrack.name;
}

function playNext() {
    if (state.queue.length === 0) return;
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
    loadTrack(state.queue[state.queueIndex]);
}

function playPrev() {
    if (state.queue.length === 0) return;
    state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
    loadTrack(state.queue[state.queueIndex]);
}

/**
 * MEDIA SESSION
 */
function updateMediaSession() {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: state.currentTrack.name,
            artist: 'Offline Player',
            album: state.activePlaylistId ? 'Playlist' : 'Library',
            artwork: [
                { src: 'https://via.placeholder.com/128', sizes: '128x128', type: 'image/png' },
            ]
        });

        navigator.mediaSession.setActionHandler('play', () => els.audio.play());
        navigator.mediaSession.setActionHandler('pause', () => els.audio.pause());
        navigator.mediaSession.setActionHandler('previoustrack', playPrev);
        navigator.mediaSession.setActionHandler('nexttrack', playNext);
    }
}

/**
 * VISUALIZER
 */
function drawVisualizer() {
    if (!state.analyser) return;

    const bufferLength = state.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const ctx = els.canvas.getContext('2d');
    const width = els.canvas.width;
    const height = els.canvas.height;

    function render() {
        requestAnimationFrame(render);
        state.analyser.getByteFrequencyData(dataArray);

        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, width, height);

        const barWidth = (width / bufferLength) * 2.5;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            barHeight = dataArray[i] / 2; 
            ctx.fillStyle = `rgb(${barHeight + 100}, 50, 150)`;
            ctx.fillRect(x, height - barHeight, barWidth, barHeight);
            x += barWidth + 1;
        }
    }
    render();
}

/**
 * INIT & EVENTS
 */
els.fileInput.addEventListener('change', (e) => saveFiles(e.target.files));
els.btnCreatePlaylist.addEventListener('click', createPlaylist);

els.btnClosePlaylist.addEventListener('click', () => {
    els.playlistView.classList.add('hidden');
    els.playlistNav.classList.remove('hidden');
    state.activePlaylistId = null;
});

els.btnCloseModal.addEventListener('click', () => els.modal.classList.add('hidden'));

els.audio.addEventListener('ended', playNext);
els.btnNext.addEventListener('click', playNext);
els.btnPrev.addEventListener('click', playPrev);

els.audio.addEventListener('pause', (e) => {
    state.isPlaying = false;
});

window.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    await loadLibrary();
    await loadPlaylists();
});


