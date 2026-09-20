class LrcSyncApp {
    constructor() {
        // Инициализация Web Audio API. Необходима для декодирования аудио, 
        // точного управления воспроизведением и получения сырых данных для отрисовки волны.
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // --- Данные ---
        this.buffer = null; // Декодированный аудио-буфер (хранит весь звук в памяти)
        this.source = null; // Текущий узел воспроизведения (в Web Audio API он создается заново при каждом Play)
        this.lrcData = [];  // Массив объектов с субтитрами: { time: Number, text: String, el: HTMLElement, ... }
        
        // --- Состояние редактора ---
        this.centerTime = 0;    // Главная ось времени приложения (секунды). Время, которое сейчас находится точно по центру экрана.
        this.zoom = 150;        // Масштаб: сколько пикселей по высоте занимает 1 секунда (px/s).
        this.dragState = null;  // Объект, хранящий информацию о текущей перетаскиваемой строке субтитров.
        
        // --- Состояние плеера ---
        this.isPlaying = false;
        this.lastRafTime = 0;   // Время предыдущего кадра анимации (нужно для вычисления дельты времени)
        this.playbackRate = 1.0; // Скорость воспроизведения (1.0 - нормальная)
        this.animFrameId = null; // ID цикла requestAnimationFrame (нужно для остановки анимации)

        // --- Кэширование ссылок на DOM-элементы ---
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
            rateSelect: document.getElementById('playback-rate')
        };

        // Получаем контекст рисования Canvas (alpha: false отключает прозрачность фона для оптимизации)
        this.ctx = this.ui.canvas.getContext('2d', { alpha: false });
        
        // Запускаем слушатели событий для первого экрана (загрузка файлов)
        this.initSetupEvents();
    }

    // Обработчики событий на экране настройки (выбор файлов)
    initSetupEvents() {
        // Функция проверки: загружены ли оба файла? Если да, разблокируем кнопку "Открыть рабочую область".
        const checkReady = () => {
            this.ui.btnStart.disabled = !(this.buffer && this.lrcData.length > 0);
        };

        // Загрузка аудиофайла
        document.getElementById('file-audio').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            // Читаем файл как ArrayBuffer и декодируем в AudioBuffer
            const arrayBuffer = await file.arrayBuffer();
            this.buffer = await this.audioCtx.decodeAudioData(arrayBuffer);
            checkReady();
        });

        // Загрузка файла субтитров
        document.getElementById('file-lrc').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            // Читаем как текст и отправляем в парсер
            const text = await file.text();
            this.parseLRC(text);
            checkReady();
        });

        // Кнопка старта работы
        this.ui.btnStart.addEventListener('click', () => {
            // Браузеры требуют взаимодействия с пользователем для запуска AudioContext. 
            // Поэтому "пробуждаем" его здесь по клику.
            if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
            this.startEditor();
        });
    }

    // Обработчики событий основного рабочего пространства
    initWorkspaceEvents() {
        // Управление колесиком мыши (масштабирование и прокрутка времени)
        this.ui.main.addEventListener('wheel', (e) => {
            e.preventDefault(); // Отключаем стандартную прокрутку страницы
            if (e.shiftKey) {
                // Если зажат Shift - меняем масштаб (zoom)
                // e.deltaY > 0 означает прокрутку вниз (уменьшение масштаба)
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                // Ограничиваем зум от 10 до 3000 пикселей на секунду
                this.zoom = Math.max(10, Math.min(this.zoom * factor, 3000));
                // Если плеер на паузе, нужно вручную перерисовать кадр с новым масштабом
                if (!this.isPlaying) this.render();
            } else {
                // Простая прокрутка - перемещение по времени.
                // Делим пиксели прокрутки на зум (пиксели/сек), чтобы получить секунды сдвига
                const delta = e.deltaY / this.zoom;
                this.seek(this.centerTime + delta);
            }
        }, { passive: false });

        // Начало перетаскивания строки субтитров (MouseDown)
        this.ui.lrcContainer.addEventListener('mousedown', (e) => {
            const lineEl = e.target.closest('.lrc-line');
            if (!lineEl) return;
            
            // Запоминаем индекс фразы в массиве и сам DOM-элемент
            const index = parseInt(lineEl.dataset.index, 10);
            this.dragState = { index, el: lineEl };
            lineEl.classList.add('dragging'); // Добавляем класс для красивой тени и цвета
        });

        // Процесс перетаскивания (MouseMove висит на window, чтобы мышь не "срывалась" при быстрых движениях)
        window.addEventListener('mousemove', (e) => {
            if (!this.dragState) return;
            
            // Вычисляем положение мыши относительно холста (Canvas)
            const rect = this.ui.canvas.getBoundingClientRect();
            const y = e.clientY - rect.top; // Координата Y внутри рабочей области
            
            // Математика: 
            // 1. (y - rect.height / 2) — смещение мыши относительно центра в пикселях.
            // 2. Делим это на this.zoom (px/sec), получаем смещение в секундах.
            // 3. Прибавляем это смещение к this.centerTime.
            // Math.max(0, ...) не дает утащить время в отрицательные значения (меньше 0 секунд).
            this.lrcData[this.dragState.index].time = Math.max(0, this.centerTime + (y - rect.height / 2) / this.zoom);
            
            if (!this.isPlaying) this.render();
        });

        // Конец перетаскивания (MouseUp)
        window.addEventListener('mouseup', () => {
            if (this.dragState) {
                this.dragState.el.classList.remove('dragging');
                this.dragState = null;
            }
        });

        // При изменении размеров окна браузера подстраиваем Canvas
        window.addEventListener('resize', () => {
            this.resizeCanvas();
            if (!this.isPlaying) this.render();
        });

        // --- Привязка кнопок управления плеером ---
        this.ui.btnPlay.addEventListener('click', () => this.togglePlay());
        
        // Обработка всех кнопок перемотки (у которых есть класс btn-seek и атрибут data-seek)
        document.querySelectorAll('.btn-seek').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Берем смещение в секундах из атрибута data-seek (например, -5, +2)
                this.seek(this.centerTime + parseFloat(e.target.dataset.seek));
            });
        });

        // Кнопки перехода к следующей/предыдущей фразе (по меткам)
        document.querySelectorAll('.btn-nav-mark').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.seekToMark(e.target.dataset.dir);
            });
        });

        // Перемотка через ползунок (Timeline / Progress Bar)
        this.ui.progressBar.addEventListener('input', (e) => {
            this.seek(parseFloat(e.target.value));
        });

        // Изменение скорости воспроизведения
        this.ui.rateSelect.addEventListener('change', (e) => {
            this.playbackRate = parseFloat(e.target.value);
            // Если сейчас играет музыка, меняем скорость на лету
            if (this.source) this.source.playbackRate.value = this.playbackRate;
        });

        // Кнопки экспорта файлов
        this.ui.btnExportLrc.addEventListener('click', () => this.export('lrc'));
        this.ui.btnExportSub.addEventListener('click', () => this.export('sub'));

        // --- Горячие клавиши (Keyboard Shortcuts) ---
        window.addEventListener('keydown', (e) => {
            if (this.ui.main.style.display !== 'flex') return; // Игнорируем, если не в рабочей зоне
            // Игнорируем нажатия, если пользователь вводит текст (если добавите текстовые поля)
            if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;

            switch (e.code) {
                case 'Space':
                case 'KeyW':
                case 'KeyS': 
                    e.preventDefault(); // Предотвращаем скролл страницы от пробела
                    this.togglePlay(); 
                    break;
                case 'KeyA': 
                    e.preventDefault(); 
                    this.seek(this.centerTime - 1); // Назад на 1 сек
                    break;
                case 'KeyD': 
                    e.preventDefault(); 
                    this.seek(this.centerTime + 1); // Вперед на 1 сек
                    break;
                case 'KeyQ': 
                    e.preventDefault(); 
                    this.seekToMark('prev'); // К предыдущей фразе
                    break;
                case 'KeyE': 
                    e.preventDefault(); 
                    this.seekToMark('next'); // К следующей фразе
                    break;
            }
        });
    }

    // Парсер субтитров: понимает и LRC (с таймингом) и обычный TXT (без тайминга)
    parseLRC(text) {
        const lines = text.split('\n'); // Разбиваем на строки
        // Регулярное выражение ищет формат: [00:00.00] текст
        const regex = /\[(\d{2}):(\d{2}(?:\.\d+)?)]\s*(.*)/; 
        
        this.lrcData = [];
        let fallbackTime = 0; // Время "по умолчанию", если загружен простой TXT файл

        lines.forEach((line) => {
            if (!line.trim()) return; // Пропускаем пустые строки
            
            const match = line.match(regex);
            if (match) {
                // Если строка с таймингом (LRC)
                // match[1] - минуты, match[2] - секунды. Переводим всё в секунды.
                const time = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
                this.lrcData.push({ time, text: match[3].trim() });
                fallbackTime = time + 2; // Если дальше будут строки без тайминга, ставим их на 2 сек позже
            } else {
                // Если строка без тайминга (TXT)
                this.lrcData.push({ time: fallbackTime, text: line.trim() });
                fallbackTime += 2; // Каждую следующую фразу раскидываем с шагом в 2 секунды
            }
        });
    }

    // Переход от стартового экрана к рабочему пространству
    startEditor() {
        this.ui.setup.style.display = 'none';
        this.ui.main.style.display = 'flex';
        
        // Настраиваем ползунок прогресса (максимум = длине трека)
        this.ui.progressBar.max = this.buffer.duration;
        this.ui.timeTotal.textContent = this.formatTime(this.buffer.duration);
        
        // Очищаем контейнер и создаем HTML-элементы для каждой строки субтитров
        this.ui.lrcContainer.innerHTML = '';
        this.lrcData.forEach((item, index) => {
            const div = document.createElement('div');
            div.className = 'lrc-line';
            div.dataset.index = index;
            
            // DOM структура узла фразы: бэйдж времени + текстовое содержимое
            const timeSpan = document.createElement('div');
            timeSpan.className = 'lrc-time-badge';
            
            const textSpan = document.createElement('div');
            textSpan.className = 'lrc-text-content';
            textSpan.textContent = item.text || '[Пустая строка]';
            
            div.appendChild(timeSpan);
            div.appendChild(textSpan);
            
            // Сохраняем ссылки на элементы прямо в объект данных, чтобы быстро двигать их при рендере
            item.el = div;
            item.elTime = timeSpan;
            item.lastTimeStr = ''; // Кэш текста времени (чтобы не дергать DOM без необходимости)
            
            this.ui.lrcContainer.appendChild(div);
        });

        this.resizeCanvas();
        this.initWorkspaceEvents();
        this.render(); // Вызываем первую отрисовку
    }

    togglePlay() { this.isPlaying ? this.pause() : this.play(); }

    play() {
        // Если уже играет или трек кончился - ничего не делаем
        if (this.isPlaying || this.centerTime >= this.buffer.duration) return;
        
        // В Web Audio API источник (AudioBufferSourceNode) является одноразовым.
        // Нельзя нажать паузу, а потом возобновить его. Нужно каждый раз создавать новый.
        this.source = this.audioCtx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.playbackRate.value = this.playbackRate; // Скорость
        this.source.connect(this.audioCtx.destination); // Подключаем к динамикам
        
        // Запускаем звук. Первый параметр (0) - когда начать (сразу). Второй - с какой секунды трека.
        this.source.start(0, this.centerTime);
        
        this.isPlaying = true;
        this.ui.btnPlay.textContent = 'Pause (S)';
        
        // Запоминаем системное время начала для точного расчета позиции в цикле анимации
        this.lastRafTime = this.audioCtx.currentTime;
        this.renderLoop(); // Запускаем цикл отрисовки 60 кадров/сек
    }

    pause() {
        if (!this.isPlaying) return;
        
        this.source.stop(); // Останавливаем узел
        this.source.disconnect();
        this.source = null; // Удаляем, сборщик мусора очистит память
        
        this.isPlaying = false;
        this.ui.btnPlay.textContent = 'Play (S)';
        
        // Останавливаем цикл requestAnimationFrame
        if (this.animFrameId) cancelAnimationFrame(this.animFrameId);
        this.render(); // Отрисовываем последний статический кадр
    }

    // Перемещение во времени (перемотка)
    seek(time) {
        const wasPlaying = this.isPlaying;
        // Если играла музыка - останавливаем (т.к. нужно пересоздать source)
        if (wasPlaying) this.pause();
        
        // Ограничиваем время: от 0 до конца трека
        this.centerTime = Math.max(0, Math.min(time, this.buffer.duration));
        this.updateTimelineUI(); // Двигаем ползунок
        
        // Если музыка играла, запускаем обратно с нового места, иначе просто рисуем кадр
        if (wasPlaying) this.play();
        else this.render();
    }

    // Умная перемотка к предыдущей/следующей строке субтитров
    seekToMark(direction) {
        if (!this.lrcData.length) return;
        
        // Создаем отсортированную копию, т.к. пользователь мог перетащить субтитры в любом порядке
        const sorted = [...this.lrcData].sort((a, b) => a.time - b.time);
        let targetTime = this.centerTime;
        const epsilon = 0.05; // Погрешность в миллисекундах (чтобы не застрять на одной отметке)

        if (direction === 'prev') {
            // Ищем с конца первую фразу, которая раньше текущего времени
            for (let i = sorted.length - 1; i >= 0; i--) {
                if (sorted[i].time < this.centerTime - epsilon) {
                    targetTime = sorted[i].time;
                    break;
                }
            }
            // Если раньше меток нет, прыгаем в самое начало (0)
            if (targetTime === this.centerTime) targetTime = 0;
        } else if (direction === 'next') {
            // Ищем с начала первую фразу, которая позже текущего времени
            for (let i = 0; i < sorted.length; i++) {
                if (sorted[i].time > this.centerTime + epsilon) {
                    targetTime = sorted[i].time;
                    break;
                }
            }
        }
        
        this.seek(targetTime);
    }

    // Главный цикл анимации при воспроизведении
    renderLoop() {
        if (!this.isPlaying) return;
        
        // this.audioCtx.currentTime - очень точные системные часы аудиокарты (не зависят от лагов JS).
        // Вычисляем, сколько секунд прошло с прошлого кадра (delta).
        const now = this.audioCtx.currentTime;
        const delta = (now - this.lastRafTime) * this.playbackRate; // Умножаем на скорость
        this.lastRafTime = now;
        
        // Двигаем центральное время приложения вперед
        this.centerTime += delta;
        
        // Автостоп в конце трека
        if (this.centerTime >= this.buffer.duration) {
            this.centerTime = this.buffer.duration;
            this.pause();
        }

        this.render(); // Отрисовка
        
        // Запрашиваем следующий кадр у браузера (обычно 60 раз в секунду)
        this.animFrameId = requestAnimationFrame(() => this.renderLoop());
    }

    // Обработка размеров Canvas с учетом Retina-дисплеев (высокая четкость)
    resizeCanvas() {
        const rect = this.ui.canvas.parentElement.getBoundingClientRect();
        // Узнаем плотность пикселей экрана (например, 2 для Mac/Retina, 1 для обычных)
        const dpr = window.devicePixelRatio || 1;
        
        // Устанавливаем физическое разрешение холста
        this.ui.canvas.width = rect.width * dpr;
        this.ui.canvas.height = rect.height * dpr;
        
        // Масштабируем контекст, чтобы рисовать в "логических" координатах (css-пикселях)
        this.ctx.scale(dpr, dpr);
        this.canvasLogicalWidth = rect.width;
        this.canvasLogicalHeight = rect.height;
    }

    // Точка входа для полной перерисовки всего интерфейса
    render() {
        this.renderWaveform();
        this.updateLrcDOM();
        this.updateTimelineUI();
    }

    // Отрисовка волны аудио и графических элементов на Canvas
    renderWaveform() {
        const width = this.canvasLogicalWidth;
        const height = this.canvasLogicalHeight;
        const halfW = width / 2;
        const halfH = height / 2;

        // Заливаем фон
        this.ctx.fillStyle = '#181818';
        this.ctx.fillRect(0, 0, width, height);
        
        if (!this.buffer) return;

        // Получаем сырые данные амплитуды (от -1.0 до 1.0) для левого канала (0)
        const data = this.buffer.getChannelData(0);
        const sampleRate = this.buffer.sampleRate; // Обычно 44100 семплов в секунду
        
        // Вычисляем, какой диапазон времени мы сейчас видим на холсте (верх и низ экрана)
        // Высота от центра до верха: halfH пикселей. Переводим это в секунды (делим на zoom).
        const startTime = this.centerTime - halfH / this.zoom;
        const endTime = this.centerTime + halfH / this.zoom;

        // Переводим секунды в индексы массива (в семплы)
        const startSample = Math.max(0, Math.floor(startTime * sampleRate));
        const endSample = Math.min(data.length, Math.ceil(endTime * sampleRate));
        
        // Сколько семплов аудио мы объединяем в один пиксель на экране (оптимизация)
        const step = Math.max(1, Math.ceil((endSample - startSample) / height));

        // === 1. Отрисовка секундной сетки в левой половине канваса ===
        const startSec = Math.ceil(startTime);
        const endSec = Math.floor(endTime);
        
        this.ctx.font = '10px monospace';
        this.ctx.textBaseline = 'middle';
        this.ctx.textAlign = 'left';

        // Проходимся по каждой целой секунде в зоне видимости
        for (let s = startSec; s <= endSec; s++) {
            // Координата Y для конкретной секунды
            const y = halfH + (s - this.centerTime) * this.zoom;
            
            // Риска (горизонтальная линия)
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
            this.ctx.fillRect(0, y, halfW, 1);
            
            // Текст (Мметка времени)
            this.ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
            this.ctx.fillText(this.formatTimeSeconds(s), 6, y - 8);
        }

        // === 2. Отрисовка амплитуды звука (волна) ===
        this.ctx.beginPath();
        this.ctx.strokeStyle = '#56b6c2'; // Цвет акцента
        this.ctx.lineWidth = 1;

        // Рисуем попиксельно по вертикали
        for (let y = 0; y < height; y++) {
            // Какому времени соответствует этот пиксель Y
            const t = this.centerTime + (y - halfH) / this.zoom;
            const idx = Math.floor(t * sampleRate); // Перевод времени в индекс семпла

            if (idx >= 0 && idx < data.length) {
                // Ищем минимум и максимум амплитуды внутри этого "шага" (step)
                let min = 0, max = 0;
                for (let i = 0; i < step && (idx + i) < data.length; i++) {
                    const val = data[idx + i];
                    if (val < min) min = val;
                    if (val > max) max = val;
                }
                
                // Рисуем горизонтальную линию амплитуды (от min до max), сдвинутую на середину холста
                // halfW * 0.9 используется чтобы оставить 10% отступа до края
                this.ctx.moveTo(halfW + min * halfW * 0.9, y);
                this.ctx.lineTo(halfW + max * halfW * 0.9, y);
            }
        }
        this.ctx.stroke();

        // === 3. Соединительные пунктирные линии от волны к блокам субтитров ===
        this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        this.ctx.setLineDash([4, 4]); // Пунктир
        this.ctx.beginPath();
        
        this.lrcData.forEach(item => {
            const y = halfH + (item.time - this.centerTime) * this.zoom;
            // Рисуем линию только если она в пределах видимости холста
            if (y >= 0 && y <= height) {
                this.ctx.moveTo(halfW, y); // Начинаем с середины экрана (от волны)
                this.ctx.lineTo(width, y); // До правого края (до блоков LRC)
            }
        });
        this.ctx.stroke();
        this.ctx.setLineDash([]); // Возвращаем сплошную линию для будущих отрисовок

        // === 4. Playhead (Центральная белая полоска текущего времени) ===
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, halfH - 0.5, width, 1);
    }

    // Синхронизация визуального положения HTML-блоков субтитров на основе их времени
    updateLrcDOM() {
        const halfH = this.canvasLogicalHeight / 2;
        
        this.lrcData.forEach(item => {
            // Вычисляем координату Y для каждого блока
            const y = halfH + (item.time - this.centerTime) * this.zoom;
            // Сдвигаем элемент по Y. Вычитаем 25px (примерно половина высоты блока), 
            // чтобы линия тайминга приходилась точно на центр блока, а не на верхний край.
            item.el.style.transform = `translateY(${y - 25}px)`; 
            
            // Обновляем текст времени в бейдже. 
            // Проверка (item.lastTimeStr) нужна для оптимизации, чтобы не дергать DOM (textContent)
            // в каждом кадре анимации (60 раз в сек), если текст не изменился.
            const timeStr = this.formatTime(item.time);
            if (item.lastTimeStr !== timeStr) {
                item.elTime.textContent = timeStr;
                item.lastTimeStr = timeStr;
            }
            
            // Оптимизация производительности: Скрываем (display: none) элементы, 
            // которые уехали далеко за пределы экрана, чтобы браузер не тратил ресурсы на их отрисовку.
            if (y < -100 || y > this.canvasLogicalHeight + 100) {
                if (item.el.style.display !== 'none') item.el.style.display = 'none';
            } else {
                if (item.el.style.display === 'none') item.el.style.display = 'flex';
            }
        });
    }

    // Обновление интерфейса панели плеера (ползунок и текст)
    updateTimelineUI() {
        // Проверяем, не держит ли пользователь сейчас фокус на ползунке 
        // (чтобы он не прыгал в руках во время ручной перемотки)
        if (document.activeElement !== this.ui.progressBar) {
            this.ui.progressBar.value = this.centerTime;
        }
        this.ui.timeCurrent.textContent = this.formatTime(this.centerTime);
    }

    // Форматирование времени для вывода: Минуты:Секунды.Сотые (00:00.00)
    formatTime(seconds) {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        const ms = Math.floor((seconds % 1) * 100).toString().padStart(2, '0');
        return `${m}:${s}.${ms}`;
    }

    // Сокращенный формат для секундной сетки на Canvas: Минуты:Секунды (00:00)
    formatTimeSeconds(seconds) {
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    // Формат для экспорта в формат SUB: Часы:Минуты:Секунды.Сотые
    formatTimeFull(seconds) {
        const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
        const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        const ms = Math.floor((seconds % 1) * 100).toString().padStart(2, '0');
        return `${h}:${m}:${s}.${ms}`;
    }

    // Экспорт синхронизированных субтитров в файл
    export(format) {
        // Сначала всегда сортируем массив по времени на случай, если пользователь перетянул фразы
        const sorted = [...this.lrcData].sort((a, b) => a.time - b.time);
        let content = "";
        let filename = "";

        if (format === 'lrc') {
            // Формат .lrc простой: [ММ:СС.СС]Текст
            content = sorted.map(item => `[${this.formatTime(item.time)}]${item.text}`).join('\n');
            filename = 'synced.lrc';
        } else if (format === 'sub') {
            // Формат .sub сложнее, он требует указания точного промежутка [Начало, Конец]
            for (let i = 0; i < sorted.length; i++) {
                const item = sorted[i];
                const nextItem = sorted[i + 1];
                
                const startTime = this.formatTimeFull(item.time);
                // Конец текущей фразы - это либо начало следующей, либо (если это последняя фраза) +2 секунды.
                const endTime = nextItem ? this.formatTimeFull(nextItem.time) : this.formatTimeFull(item.time + 2);
                
                content += `${startTime},${endTime}\n${item.text}\n\n`;
            }
            filename = 'synced.sub';
        }

        // Вызов окна "Сохранить как..." через невидимую ссылку
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob); // Создаем временный URL-адрес для файла в памяти браузера
        
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click(); // Эмулируем клик по ссылке скачивания
        
        URL.revokeObjectURL(url); // Очищаем память, удаляя временный URL
    }
}

// Запускаем приложение только после того, как весь HTML был загружен и DOM-дерево построено
document.addEventListener('DOMContentLoaded', () => new LrcSyncApp());