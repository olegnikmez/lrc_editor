class LrcSyncApp {
    constructor() {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        this.buffer = null; 
        this.source = null; 
        this.lrcData = [];  
        
        this.centerTime = 0;    
        this.zoom = 150;        
        this.dragState = null;  
        
        this.isPlaying = false;
        this.lastRafTime = 0;   
        this.playbackRate = 1.0; 
        this.animFrameId = null; 

        this.ui = {
            setup: document.getElementById('setup-screen'),
            main: document.getElementById('main-screen'),
            canvas: document.getElementById('waveform'),
            lrcContainer: document.getElementById('lrc-container'),
            btnStart: document.getElementById('btn-start'),
            btnPlay: document.getElementById('btn-play'),
            btnExportLrc: document.getElementById('btn-export-lrc'),
            btnExportSub: document.getElementById('btn-export-sub'),
            progressBar: document.getElementById('progress-bar'),
            timeCurrent: document.getElementById('time-current'),
            timeTotal: document.getElementById('time-total'),
            rateSelect: document.getElementById('playback-rate'),
            // --- UI Модального окна ---
            btnAddText: document.getElementById('btn-add-text'),
            modalText: document.getElementById('modal-text'),
            modalTextarea: document.getElementById('modal-textarea'),
            modalBtnCancel: document.getElementById('modal-btn-cancel'),
            modalBtnSave: document.getElementById('modal-btn-save')
        };

        this.ctx = this.ui.canvas.getContext('2d', { alpha: false });
        
        this.initSetupEvents();
        this.initModalEvents();
    }

    initSetupEvents() {
        const checkReady = () => {
            this.ui.btnStart.disabled = !(this.buffer && this.lrcData.length > 0);
        };

        document.getElementById('file-audio').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const arrayBuffer = await file.arrayBuffer();
            this.buffer = await this.audioCtx.decodeAudioData(arrayBuffer);
            checkReady();
        });

        document.getElementById('file-lrc').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const text = await file.text();
            this.parseLRC(text);
            checkReady();
        });

        this.ui.btnStart.addEventListener('click', () => {
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            this.startEditor();
        });
    }

    initModalEvents() {
        this.ui.btnAddText.addEventListener('click', () => {
            this.ui.modalText.style.display = 'flex';
            this.ui.modalTextarea.value = '';
            this.ui.modalTextarea.focus();
        });

        this.ui.modalBtnCancel.addEventListener('click', () => {
            this.ui.modalText.style.display = 'none';
        });

        this.ui.modalBtnSave.addEventListener('click', () => {
            this.injectTextData();
        });

        // --- Отправка текста по Enter ---
        this.ui.modalTextarea.addEventListener('keydown', (e) => {
            // Если нажат Enter и НЕ нажат Shift
            if (e.code === 'Enter' && !e.shiftKey) {
                e.preventDefault(); // Предотвращаем добавление переноса строки
                this.injectTextData(); // Запускаем процесс ассимиляции текста
            }
        });
    }

    initWorkspaceEvents() {
        this.ui.main.addEventListener('wheel', (e) => {
            e.preventDefault(); 
            if (e.shiftKey) {
                const wheelDelta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
                const factor = wheelDelta > 0 ? 0.9 : 1.1;
                this.zoom = Math.max(10, Math.min(this.zoom * factor, 3000));
                if (!this.isPlaying) this.render();
            } else {
                const delta = e.deltaY / this.zoom;
                this.seek(this.centerTime + delta);
            }
        }, { passive: false });

        // Делегирование событий двойного клика по тексту
        this.ui.lrcContainer.addEventListener('dblclick', (e) => {
            const textEl = e.target.closest('.lrc-text-content');
            if (textEl) this.initTextEdit(textEl);
        });

        // Делегирование событий клика по иконкам действий
        this.ui.lrcContainer.addEventListener('click', (e) => {
            // Обработка редактирования
            const editBtn = e.target.closest('.lrc-edit-icon');
            if (editBtn) {
                const textEl = editBtn.closest('.lrc-line').querySelector('.lrc-text-content');
                this.initTextEdit(textEl);
                return;
            }

            // Обработка удаления
            const deleteBtn = e.target.closest('.lrc-delete-icon');
            if (deleteBtn) {
                if (window.confirm('Удалить этот блок текста?')) {
                    const lineEl = deleteBtn.closest('.lrc-line');
                    const index = parseInt(lineEl.dataset.index, 10);
                    
                    // 1. Удаляем из стейта
                    this.lrcData.splice(index, 1);
                    
                    // 2. Удаляем из DOM
                    lineEl.remove();
                    
                    // 3. Переиндексируем оставшиеся узлы
                    const remainingLines = this.ui.lrcContainer.querySelectorAll('.lrc-line');
                    remainingLines.forEach((el, newIdx) => {
                        el.dataset.index = newIdx;
                    });
                    
                    // 4. Обновляем канвас (удаляем маркер линии субтитра)
                    if (!this.isPlaying) this.render();
                }
            }
        });

        this.ui.lrcContainer.addEventListener('mousedown', (e) => {
            // Блокировка drag & drop на обеих кнопках действий
            if (e.target.closest('.lrc-action-icon') || e.target.isContentEditable) return;

            const lineEl = e.target.closest('.lrc-line');
            if (!lineEl) return;
            
            // Блокируем дрейф времени
            if (this.isPlaying) this.pause();

            const index = parseInt(lineEl.dataset.index, 10);
            const rect = this.ui.canvas.getBoundingClientRect();
            const cursorY = e.clientY - rect.top;
            const itemY = (this.canvasLogicalHeight / 2) + (this.lrcData[index].time - this.centerTime) * this.zoom;

            this.dragState = { 
                index, 
                el: lineEl,
                grabOffsetY: cursorY - itemY,
                canvasTop: rect.top
            };
            lineEl.classList.add('dragging'); 
        });

        window.addEventListener('mousemove', (e) => {
            if (!this.dragState) return;
            
            const cursorY = e.clientY - this.dragState.canvasTop; 
            const halfH = this.canvasLogicalHeight / 2;
            const targetY = cursorY - this.dragState.grabOffsetY;
            
            // Ограничиваем диапазон [0, duration]
            const newTime = this.centerTime + (targetY - halfH) / this.zoom;
            this.lrcData[this.dragState.index].time = Math.max(0, Math.min(newTime, this.buffer.duration));
            
            if (!this.isPlaying) this.render();
        });

        window.addEventListener('mouseup', () => {
            if (this.dragState) {
                this.dragState.el.classList.remove('dragging');
                this.dragState = null;
            }
        });

        window.addEventListener('resize', () => {
            this.resizeCanvas();
            if (!this.isPlaying) this.render();
        });

        this.ui.btnPlay.addEventListener('click', () => this.togglePlay());
        
        document.querySelectorAll('.btn-seek').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.seek(this.centerTime + parseFloat(e.target.dataset.seek));
            });
        });

        document.querySelectorAll('.btn-nav-mark').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.seekToMark(e.target.dataset.dir);
            });
        });

        this.ui.progressBar.addEventListener('input', (e) => {
            this.seek(parseFloat(e.target.value));
        });

        this.ui.rateSelect.addEventListener('change', (e) => {
            this.playbackRate = parseFloat(e.target.value);
            if (this.source) this.source.playbackRate.value = this.playbackRate;
        });

        this.ui.btnExportLrc.addEventListener('click', () => this.export('lrc'));
        this.ui.btnExportSub.addEventListener('click', () => this.export('sub'));

        window.addEventListener('keydown', (e) => {
            if (this.ui.main.style.display !== 'flex') return;
            
            // Блокируем горячие клавиши при вводе текста, включая contenteditable
            const isEditingText = ['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
            if (isEditingText && e.target.type !== 'range') return;

            switch (e.code) {
                case 'KeyN':
                    e.preventDefault();
                    this.ui.modalText.style.display = 'flex';
                    this.ui.modalTextarea.value = '';
                    this.ui.modalTextarea.focus();
                    break;
                case 'Space':
                case 'KeyW':
                case 'KeyS': 
                    e.preventDefault(); 
                    this.togglePlay(); 
                    break;
                case 'KeyA': 
                    e.preventDefault(); 
                    this.seek(this.centerTime - 1); 
                    break;
                case 'KeyD': 
                    e.preventDefault(); 
                    this.seek(this.centerTime + 1); 
                    break;
                case 'KeyQ': 
                    e.preventDefault(); 
                    this.seekToMark('prev'); 
                    break;
                case 'KeyE': 
                    e.preventDefault(); 
                    this.seekToMark('next'); 
                    break;
            }
        });
    }

    parseLRC(text) {
        const lines = text.split('\n'); 
        const regex = /\[(\d{2}):(\d{2}(?:\.\d+)?)]\s*(.*)/; 
        
        this.lrcData = [];
        let fallbackTime = 0; 

        lines.forEach((line) => {
            if (!line.trim()) return; 
            
            const match = line.match(regex);
            if (match) {
                const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
                this.lrcData.push({ time, text: match[3].trim() });
                fallbackTime = time + 2; 
            } else {
                this.lrcData.push({ time: fallbackTime, text: line.trim() });
                fallbackTime += 2; 
            }
        });
    }

    // Парсинг гибридного массива из модального окна и интеграция в текущий стейт
    injectTextData() {
        const rawText = this.ui.modalTextarea.value;
        if (!rawText.trim()) {
            this.ui.modalText.style.display = 'none';
            return;
        }

        const lines = rawText.split('\n');
        let cursorTime = this.centerTime; // Вектор времени для узлов без меток
        
        const lrcRegex = /^\[(\d{2}):(\d{2}(?:\.\d+)?)]\s*(.*)/;
        const subRegex = /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?),(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;

        const fragmentData = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i].trim();
            if (!line) { i++; continue; }

            // Анализ на сигнатуру LRC
            const lrcMatch = line.match(lrcRegex);
            if (lrcMatch) {
                const time = parseInt(lrcMatch[1], 10) * 60 + parseFloat(lrcMatch[2]);
                fragmentData.push({ time, text: lrcMatch[3].trim() });
                cursorTime = time + 2;
                i++;
                continue;
            }

            // Анализ на сигнатуру SUB
            const subMatch = line.match(subRegex);
            if (subMatch) {
                const time = parseInt(subMatch[1], 10) * 3600 + parseInt(subMatch[2], 10) * 60 + parseFloat(subMatch[3]);
                let textBlock = '';
                
                // В SUB-формате следующая не-пустая строка без временных меток считается текстом фразы
                if (i + 1 < lines.length && lines[i+1].trim() !== '' && !lrcRegex.test(lines[i+1]) && !subRegex.test(lines[i+1])) {
                    textBlock = lines[i+1].trim();
                    i++; 
                }
                
                fragmentData.push({ time, text: textBlock });
                cursorTime = time + 2;
                i++;
                continue;
            }

            // Обычный текст без временной метки привязывается к курсору времени
            fragmentData.push({ time: cursorTime, text: line });
            cursorTime += 2;
            i++;
        }

        // Ассимиляция новых DOM-узлов
        const startIndex = this.lrcData.length;
        fragmentData.forEach((item, idx) => {
            this.createLrcNode(item, startIndex + idx);
            this.lrcData.push(item);
        });

        this.ui.modalText.style.display = 'none';
        this.render();
    }

    // DRY: Инкапсуляция логики создания DOM-узла
    createLrcNode(item, index) {
        const div = document.createElement('div');
        div.className = 'lrc-line';
        div.dataset.index = index;
        div.style.top = '0'; // Гарантирует абсолютный базис для translateY

        const timeSpan = document.createElement('div');
        timeSpan.className = 'lrc-time-badge';
        
        const textSpan = document.createElement('div');
        textSpan.className = 'lrc-text-content';
        textSpan.textContent = item.text || '[Пустая строка]';

        // Контейнер для кнопок управления
        const actionsDiv = document.createElement('div');
        actionsDiv.className = 'lrc-actions';

        const editIcon = document.createElement('div');
        editIcon.className = 'lrc-action-icon lrc-edit-icon';
        editIcon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
        
        const deleteIcon = document.createElement('div');
        deleteIcon.className = 'lrc-action-icon lrc-delete-icon';
        // Иконка корзины (Material Design)
        deleteIcon.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

        actionsDiv.appendChild(editIcon);
        actionsDiv.appendChild(deleteIcon);
        
        div.appendChild(timeSpan);
        div.appendChild(textSpan);
        div.appendChild(actionsDiv); // Интегрируем контейнер вместо одиночной иконки
        
        item.el = div;
        item.elTime = timeSpan;
        item.lastTimeStr = '';
        
        this.ui.lrcContainer.appendChild(div);
    }

    startEditor() {
        this.ui.setup.style.display = 'none';
        this.ui.main.style.display = 'flex';
        
        this.ui.progressBar.max = this.buffer.duration;
        this.ui.timeTotal.textContent = this.formatTime(this.buffer.duration);
        
        this.ui.lrcContainer.innerHTML = '';
        
        // Генерация первично загруженных узлов
        this.lrcData.forEach((item, index) => {
            this.createLrcNode(item, index);
        });

        this.resizeCanvas();
        this.initWorkspaceEvents();
        this.render(); 
    }

    togglePlay() { this.isPlaying ? this.pause() : this.play(); }

    play() {
        if (this.isPlaying || this.centerTime >= this.buffer.duration) return;
        
        this.source = this.audioCtx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.playbackRate.value = this.playbackRate; 
        this.source.connect(this.audioCtx.destination); 
        
        this.source.start(0, this.centerTime);
        
        this.isPlaying = true;
        this.ui.btnPlay.textContent = 'Pause (S)';
        
        this.lastRafTime = this.audioCtx.currentTime;
        this.renderLoop(); 
    }

    pause() {
        if (!this.isPlaying) return;
        
        this.source.stop(); 
        this.source.disconnect();
        this.source = null; 
        
        this.isPlaying = false;
        this.ui.btnPlay.textContent = 'Play (S)';
        
        if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
        this.render(); 
    }

    seek(time) {
        const wasPlaying = this.isPlaying;
        if (wasPlaying) this.pause();
        
        this.centerTime = Math.max(0, Math.min(time, this.buffer.duration));
        this.updateTimelineUI(); 
        
        if (wasPlaying) this.play();
        else this.render();
    }

    seekToMark(direction) {
        if (!this.lrcData.length) return;
        
        const sorted = [...this.lrcData].sort((a, b) => a.time - b.time);
        let targetTime = this.centerTime;
        const epsilon = 0.005; // 5 мс вместо 50 мс для исключения пропуска меток

        if (direction === 'prev') {
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (sorted[i].time < this.centerTime - epsilon) {
                    targetTime = sorted[i].time;
                    break;
                }
            }
            if (targetTime === this.centerTime) targetTime = 0;
        } else if (direction === 'next') {
            for (let i = 0; i < sorted.length; i++) {
                if (sorted[i].time > this.centerTime + epsilon) {
                    targetTime = sorted[i].time;
                    break;
                }
            }
        }
        
        this.seek(targetTime);
    }

    renderLoop() {
        if (!this.isPlaying) return;
        
        const now = this.audioCtx.currentTime;
        const delta = (now - this.lastRafTime) * this.playbackRate; 
        this.lastRafTime = now;
        
        this.centerTime += delta;
        
        if (this.centerTime >= this.buffer.duration) {
            this.centerTime = this.buffer.duration;
            this.pause();
        }

        this.render(); 
        
        this.animFrameId = requestAnimationFrame(() => this.renderLoop());
    }

    resizeCanvas() {
        const rect = this.ui.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        
        // Битовый сдвиг & ~1 гарантирует строго четное целое число
        this.canvasLogicalWidth = Math.floor(rect.width) & ~1;
        this.canvasLogicalHeight = Math.floor(rect.height) & ~1;
        
        // Жестко фиксируем CSS-размеры холста, чтобы избежать билинейного размытия из-за height: 100%
        this.ui.canvas.style.width = `${this.canvasLogicalWidth}px`;
        this.ui.canvas.style.height = `${this.canvasLogicalHeight}px`;

        // Передаем точный центр в CSS для идеальной синхронизации визира рабочей области
        this.ui.main.style.setProperty('--center-y', `${this.canvasLogicalHeight / 2}px`);
        
        this.ui.canvas.width = this.canvasLogicalWidth * dpr;
        this.ui.canvas.height = this.canvasLogicalHeight * dpr;
        
        this.ctx.scale(dpr, dpr);
    }

    render() {
        this.renderWaveform();
        this.updateLrcDOM();
        this.updateTimelineUI();
    }

    renderWaveform() {
        const width = this.canvasLogicalWidth;
        const height = this.canvasLogicalHeight;
        const halfW = width / 2;
        const halfH = height / 2;

        this.ctx.fillStyle = '#181818';
        this.ctx.fillRect(0, 0, width, height);
        
        if (!this.buffer) return;

        const data = this.buffer.getChannelData(0);
        const sampleRate = this.buffer.sampleRate; 
        const step = Math.max(1, Math.ceil(sampleRate / this.zoom));

        const startTime = this.centerTime - halfH / this.zoom;
        const endTime = this.centerTime + halfH / this.zoom;

        const startSec = Math.max(0, Math.ceil(startTime));
        const endSec = Math.floor(endTime);
        
        this.ctx.font = '10px monospace';
        this.ctx.textBaseline = 'middle';
        this.ctx.textAlign = 'left';

        // 1. Сетка секунд
        for (let s = startSec; s <= endSec; s++) {
            const y = Math.floor(halfH + (s - this.centerTime) * this.zoom);
            
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
            this.ctx.fillRect(0, y, halfW, 1);
            
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            this.ctx.fillText(this.formatTimeSeconds(s), 6, y - 8);
        }

        // 2. Волна сигнала (с захватом граничных сэмплов)
        this.ctx.beginPath();
        this.ctx.strokeStyle = '#56b6c2'; 
        this.ctx.lineWidth = 1;

        for (let y = 0; y < height; y++) {
            const t = this.centerTime + (y - halfH) / this.zoom;
            const idx = Math.floor(t * sampleRate); 
            const endIdx = idx + step;

            // Сканируем срез, если хотя бы часть диапазона лежит внутри буфера
            if (endIdx > 0 && idx < data.length) {
                const scanStart = Math.max(0, idx);
                const scanEnd = Math.min(endIdx, data.length);
                
                let min = 0, max = 0;
                for (let i = scanStart; i < scanEnd; i++) {
                    const val = data[i];
                    if (val < min) min = val;
                    if (val > max) max = val;
                }
                const strokeY = y + 0.5;
                this.ctx.moveTo(halfW + min * halfW * 0.9, strokeY);
                this.ctx.lineTo(halfW + max * halfW * 0.9, strokeY);
            }
        }
        this.ctx.stroke();

        // 3. Линии субтитров
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        this.ctx.setLineDash([4, 4]); 
        this.ctx.beginPath();
        
        this.lrcData.forEach(item => {
            const y = Math.floor(halfH + (item.time - this.centerTime) * this.zoom) + 0.5;
            if (y >= 0 && y <= height) {
                this.ctx.moveTo(halfW, y); 
                this.ctx.lineTo(width, y); 
            }
        });
        this.ctx.stroke();
        this.ctx.setLineDash([]); 

        // 4. Центральный визир
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, Math.floor(halfH), width, 1);
    }

    updateLrcDOM() {
        const halfH = this.canvasLogicalHeight / 2;
        
        this.lrcData.forEach(item => {
            const y = Math.floor(halfH + (item.time - this.centerTime) * this.zoom);
            
            // Если узел далеко за экраном — скрываем и прерываем итерацию
            if (y < -100 || y > this.canvasLogicalHeight + 100) {
                if (item.el.style.display !== 'none') item.el.style.display = 'none';
                return; // Отсекаем ненужные вычисления DOM transform
            }
            
            if (item.el.style.display === 'none') item.el.style.display = 'flex';
            
            item.el.style.transform = `translateY(${y - 16}px)`; 
            
            const timeStr = this.formatTime(item.time);
            if (item.lastTimeStr !== timeStr) {
                item.elTime.textContent = timeStr;
                item.lastTimeStr = timeStr;
            }
        });
    }

    updateTimelineUI() {
        if (document.activeElement !== this.ui.progressBar) {
            this.ui.progressBar.value = this.centerTime;
        }
        this.ui.timeCurrent.textContent = this.formatTime(this.centerTime);
    }

    formatTime(seconds) {
        const totalCs = Math.round(seconds * 100);
        const m = Math.floor(totalCs / 6000).toString().padStart(2, '0');
        const s = Math.floor((totalCs % 6000) / 100).toString().padStart(2, '0');
        const cs = (totalCs % 100).toString().padStart(2, '0');
        return `${m}:${s}.${cs}`;
    }

    formatTimeSeconds(seconds) {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    formatTimeFull(seconds) {
        const totalCs = Math.round(seconds * 100);
        const h = Math.floor(totalCs / 360000).toString().padStart(2, '0');
        const m = Math.floor((totalCs % 360000) / 6000).toString().padStart(2, '0');
        const s = Math.floor((totalCs % 6000) / 100).toString().padStart(2, '0');
        const cs = (totalCs % 100).toString().padStart(2, '0');
        return `${h}:${m}:${s}.${cs}`;
    }

    export(format) {
        const sorted = [...this.lrcData].sort((a, b) => a.time - b.time);
        let content = "";
        let filename = "";

        if (format === 'lrc') {
            content = sorted.map(item => `[${this.formatTime(item.time)}]${item.text}`).join('\n');
            filename = 'synced.lrc';
        } else if (format === 'sub') {
            for (let i = 0; i < sorted.length; i++) {
                const item = sorted[i];
                const nextItem = sorted[i + 1];
                
                const startTime = this.formatTimeFull(item.time);
                const endTime = nextItem ? this.formatTimeFull(nextItem.time) : this.formatTimeFull(item.time + 2);
                
                content += `${startTime},${endTime}\n${item.text}\n\n`;
            }
            filename = 'synced.sub';
        }

        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob); 
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click(); 
        
        URL.revokeObjectURL(url); 
    }

    // Инициализация режима редактирования текста
    initTextEdit(textNode) {
        if (textNode.isContentEditable) return;

        const lineEl = textNode.closest('.lrc-line');
        const index = parseInt(lineEl.dataset.index, 10);
        const item = this.lrcData[index];
        const originalText = item.text;

        textNode.contentEditable = true;
        textNode.focus();

        // Установка каретки в конец текста
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(textNode);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);

        // Замыкание для завершения редактирования
        const finalizeEdit = (save) => {
            textNode.contentEditable = false;
            textNode.removeEventListener('blur', blurHandler);
            textNode.removeEventListener('keydown', keyHandler);

            if (save) {
                // Убираем пробелы
                item.text = textNode.textContent.trim(); 
                
                // UX-защита: если строку стерли, возвращаем плейсхолдер
                if (!item.text) {
                    textNode.textContent = '[Пустая строка]';
                }
            } else {
                textNode.textContent = originalText;
            }
        };

        const blurHandler = () => finalizeEdit(true);
        const keyHandler = (e) => {
            if (e.code === 'Enter') {
                e.preventDefault();
                textNode.blur(); // Инициирует сохранение через blurHandler
            } else if (e.code === 'Escape') {
                e.preventDefault();
                finalizeEdit(false); // Откат изменений
            }
        };

        textNode.addEventListener('blur', blurHandler);
        textNode.addEventListener('keydown', keyHandler);
    }
}

// Запускаем приложение только после того, как весь HTML был загружен и DOM-дерево построено
document.addEventListener('DOMContentLoaded', () => new LrcSyncApp());