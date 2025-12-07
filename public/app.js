const BACKEND_URL = 'http://127.0.0.1:5500node server.js'; // غيّرها لو السيرفر على دومين تاني

// MQTT Configuration - HiveMQ Cloud via WebSocket
const MQTT_SERVER = "wss://614bc7bd073f4283a92bee028ccabaff.s1.eu.hivemq.cloud:8884/mqtt";
const STATUS_TOPIC  = "home/status";
const COMMAND_TOPIC = "home/command";

const MQTT_USER = "ESP32";
const MQTT_PASS = "Ziad1272009";
const CLIENT_ID = "aegiscore_web_" + Math.random().toString(16).substr(2, 8);

// Main class to handle application logic
class AegisCore {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.currentStatus = {};

        this.reconnectInterval = null;
        this.notificationToast = null;
        this.seenEnabled = false;

        // 🔔 Notifications flag
        this.notificationsEnabled = false;

        // Flags
        this.flags = {
            waterSensorEnabled: null,
            flameSensorEnabled: null,
            gasSensorEnabled: null,
            waterValveClosed: null,
            gasValveClosed: null
        };

        // Data store
        this.dataStore = {
            daily: {}
        };

        this.charts = {
            water: null,
            flame: null,
            gas: null,
            temp: null,
            motion: null
        };

        this._hasAnimatedOnLoad = false;

        this.initializeApp();
    }

    // Initialize application
    initializeApp() {
        this.loadStoredData();
        this.loadNotificationsFlag();
        this.setDefaultDateInput();
        this.setupEventListeners();
        this.initializeToast();
        this.initializeCharts();
        this.connectToMQTT();
        this.refreshAnalytics();
        this.animateOnceOnLoad();
        this.initializeNotificationsUI();
    }

    async setupPushSubscription() {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('Push not supported in this browser');
            return;
        }

        const reg = await navigator.serviceWorker.ready;

        // هنسأل السيرفر عن الـ public key
        const res = await fetch(`${BACKEND_URL}/vapidPublicKey`);
        const data = await res.json();
        const publicKey = data.publicKey;

        // نحول الـ base64 public key لـ Uint8Array
        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding)
                .replace(/-/g, '+')
                .replace(/_/g, '/');

            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);

            for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        }

        const applicationServerKey = urlBase64ToUint8Array(publicKey);

        const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey
        });

        // نبعت الـ subscription للسيرفر
        await fetch(`${BACKEND_URL}/subscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription)
        });

        console.log('Push subscription sent to backend');
    }


    // Load stored data
    loadStoredData() {
        const stored = localStorage.getItem('aegiscore_data');
        if (stored) {
            try {
                this.dataStore = JSON.parse(stored);
            } catch (e) {
                console.warn('Failed to parse stored data, resetting.', e);
                this.dataStore = { daily: {} };
            }
        } else {
            this.dataStore = { daily: {} };
        }

        const today = this.getCurrentDate();
        if (!this.dataStore.daily[today]) {
            this.dataStore.daily[today] = { detailed: [] };
        }
    }

    saveStoredData() {
        try {
            localStorage.setItem('aegiscore_data', JSON.stringify(this.dataStore));
        } catch (e) {
            console.warn('Failed to save data to localStorage', e);
        }
    }

    // 🔁 Reset all stored sensor data
    resetAllData() {
        if (!confirm('Are you sure you want to reset all stored data?')) return;
        this.dataStore = { daily: {} };
        this.saveStoredData();
        this.refreshAnalytics();
        this.showNotification('All stored sensor data has been reset.', 'success', 4000);
    }

    // Notifications flag load/save
    loadNotificationsFlag() {
        const stored = localStorage.getItem('aegiscore_notifications');
        this.notificationsEnabled = stored === 'true';
    }

    saveNotificationsFlag() {
        localStorage.setItem('aegiscore_notifications', this.notificationsEnabled ? 'true' : 'false');
    }

    // Get current date in YYYY-MM-DD format
    getCurrentDate() {
        return new Date().toISOString().split('T')[0];
    }

    setDefaultDateInput() {
        const dateInput = document.getElementById('dateSelector');
        if (dateInput) {
            dateInput.value = this.getCurrentDate();
        }
    }

    getSelectedDate() {
        const dateInput = document.getElementById('dateSelector');
        return (dateInput && dateInput.value) ? dateInput.value : this.getCurrentDate();
    }

    getSelectedDataType() {
        const select = document.getElementById('dataTypeSelector');
        return select ? select.value : 'all';
    }

    getSelectedResolution() {
        const select = document.getElementById('chartResolution');
        return select ? select.value : 'raw';
    }

    // Toast notifications (inside web)
    initializeToast() {
        try {
            const toastEl = document.getElementById('notificationToast');
            if (toastEl) {
                this.notificationToast = new bootstrap.Toast(toastEl, {
                    delay: 5000
                });
            }
        } catch (e) {
            console.warn('Bootstrap toast init failed', e);
            this.notificationToast = null;
        }
    }

    // 🔔 Show notification (toast + optional browser notification)
    showNotification(message, type = 'danger', duration = 5000) {
        const toast = document.getElementById('notificationToast');
        const toastMessage = document.getElementById('toastMessage');
        if (toast && toastMessage) {
            let bgClass = type;
            if (type === 'info') bgClass = 'primary';
            if (type === 'success') bgClass = 'success';
            if (type === 'warning') bgClass = 'warning';
            
            toast.className = `notification-toast toast align-items-center text-white bg-${bgClass} border-0`;
            toastMessage.textContent = message;

            if (this.notificationToast) {
                this.notificationToast.show();
                setTimeout(() => this.notificationToast.hide(), duration);
            } else {
                console.log('Notification:', message);
            }
        } else {
            console.log('Notification:', message);
        }

        // Browser notification (requires permission + enabled)
        if (this.notificationsEnabled && 'Notification' in window && Notification.permission === 'granted') {
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistration().then(reg => {
                    if (reg) {
                        reg.showNotification('AegisCore Alert', {
                            body: message,
                            icon: '/Gemini_Generated_Image_kevgvmkevgvmkevg.png',
                            badge: '/Gemini_Generated_Image_kevgvmkevgvmkevg.png',
                            tag: 'aegiscore-alert'
                        });
                    } else {
                        new Notification('AegisCore Alert', { body: message });
                    }
                }).catch(() => {
                    new Notification('AegisCore Alert', { body: message });
                });
            } else {
                new Notification('AegisCore Alert', { body: message });
            }
        }
    }

    // 🔔 Initialize notifications button UI
    initializeNotificationsUI() {
        const btn = document.getElementById('enableNotificationsBtn');
        if (!btn) return;

        if (!('Notification' in window)) {
            btn.disabled = true;
            btn.textContent = 'Notifications not supported';
            return;
        }

        if (this.notificationsEnabled && Notification.permission === 'granted') {
            btn.style.display = 'none';
        } else {
            btn.style.display = 'inline-flex';
        }

        // لو الإذن موجود أصلاً من قبل – فعل الفلاج
        if (Notification.permission === 'granted' && !this.notificationsEnabled) {
            this.notificationsEnabled = true;
            this.saveNotificationsFlag();
            btn.style.display = 'none';
        }

        // لو notificationsEnabled=true من قبل لكن permission اتغيرت لـ denied – نوقفها
        if (Notification.permission === 'denied') {
            this.notificationsEnabled = false;
            this.saveNotificationsFlag();
        }

        // Register SW لو notificationsEnabled بالفعل
        if (this.notificationsEnabled && 'serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(err => {
                console.warn('Service worker register failed:', err);
            });
        }
    }

    // 🔔 Request notification permission
    async requestNotificationsPermission() {
        if (!('Notification' in window)) {
            this.showNotification('Notifications are not supported in this browser.', 'warning');
            return;
        }

        const btn = document.getElementById('enableNotificationsBtn');

        try {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                this.notificationsEnabled = true;
                this.saveNotificationsFlag();
                if ('serviceWorker' in navigator) {
                    try {
                        await navigator.serviceWorker.register('/sw.js');
                    } catch (err) {
                        console.warn('Service worker registration failed:', err);
                    }
                }
                if (btn) btn.style.display = 'none';
                this.showNotification('Browser notifications enabled.', 'success', 3000);
                this.setupPushSubscription().catch(err => {
                    console.error('Push subscription error:', err);
                });
            } else if (permission === 'denied') {
                this.notificationsEnabled = false;
                this.saveNotificationsFlag();
                this.showNotification('Notifications were blocked by the browser.', 'warning', 4000);
            } else {
                this.showNotification('Notification permission was not granted.', 'info', 3000);
            }
        } catch (err) {
            console.error('Notification permission error:', err);
            this.showNotification('Failed to enable notifications.', 'danger', 4000);
        }
    }

    // Connect to MQTT broker
    connectToMQTT() {
        console.log('Connecting to:', MQTT_SERVER);

        this.client = mqtt.connect(MQTT_SERVER, {
            clientId: CLIENT_ID,
            username: MQTT_USER,
            password: MQTT_PASS,
            clean: true,
            reconnectPeriod: 5000   // 🔁 Auto reconnect while tab is open
        });

        this.client.on('connect', () => {
            console.log('MQTT Connected!');
            this.updateConnectionStatus(true);
            this.client.subscribe(STATUS_TOPIC, (err) => {
                if (err) console.error('Subscribe error:', err);
                else console.log('Subscribed to:', STATUS_TOPIC);
            });

            // أول ما يتوصل – حدث حالة الـ SEEN حسب الـ visibility
            this.handleVisibilityChange();
        });

        this.client.on('reconnect', () => {
            console.log('Reconnecting...');
        });

        this.client.on('error', (err) => {
            console.error('MQTT Error:', err);
            this.updateConnectionStatus(false);
        });

        this.client.on('close', () => {
            console.log('MQTT connection closed');
            this.updateConnectionStatus(false);
        });

        this.client.on('message', (topic, message) => {
            const payload = message.toString();
            this.handleMessage(topic, payload);
        });
    }

    handleMessage(topic, payload) {
        console.log('MQTT RAW MESSAGE:', topic, payload);

        if (topic !== STATUS_TOPIC) return;

        if (!payload || payload[0] !== '{') {
            console.warn('Ignoring non-JSON payload:', payload);
            return;
        }

        let status;
        try {
            status = JSON.parse(payload);
        } catch (e) {
            console.error('JSON parse failed for payload:', payload, e);
            return;
        }

        this.currentStatus = status;
        this.updateUI(status);
        this.checkForAlerts(status);
        this.storeSensorData(status);
        this.updateRtc(status);
        this.refreshAnalytics();
    }

    /* UI Updates */
    updateUI(status) {
        this.updateSensor('water', status.water, status.water_leak);
        this.updateSensor('flame', status.flame, status.flame_leak);
        this.updateSensor('gas', status.gas, status.gas_leak);
        this.updateTemperature(status.temp, status.fan);
        this.updateSecurity(status.pir_armed, status.motion);
        this.updateValve('water', status.valve_water_closed);
        this.updateValve('gas', status.valve_gas_closed);
        this.updateSensorToggle('water', status.water_sensor_enabled);
        this.updateSensorToggle('flame', status.flame_sensor_enabled);
        this.updateSensorToggle('gas', status.gas_sensor_enabled);

        if (typeof status.seen !== 'undefined') {
            this.updateSeen(status.seen);
        }
    }

    updateSensor(type, value, isLeak) {
        const valueElement  = document.getElementById(type + 'Value');
        const statusElement = document.getElementById(type + 'Status');
        const cardElement   = document.getElementById(type + 'SensorCard');

        if (valueElement) valueElement.textContent = value;

        if (statusElement) {
            if (isLeak) {
                statusElement.textContent = (type === 'flame' ? 'FIRE!' : 'LEAK!');
                statusElement.className = 'alert-status bg-danger';
            } else {
                statusElement.textContent = 'Normal';
                statusElement.className = 'alert-status bg-success';
            }
        }

        if (cardElement) {
            if (isLeak) {
                cardElement.style.border = '2px solid #C62828';
                cardElement.classList.add('alert');
            } else {
                cardElement.style.border = '';
                cardElement.classList.remove('alert');
            }
        }
    }

    updateTemperature(temp, fanOn) {
        const tempElement = document.getElementById('tempValue');
        const fanElement  = document.getElementById('fanStatus');
        const cardElement = document.getElementById('tempSensorCard');

        if (tempElement) tempElement.textContent = temp + '°C';

        if (fanElement) {
            if (fanOn) {
                fanElement.textContent = 'FAN ON';
                fanElement.className = 'alert-status bg-warning text-dark';
            } else {
                fanElement.textContent = 'Normal';
                fanElement.className = 'alert-status bg-success';
            }
        }

        if (cardElement) {
            cardElement.style.border = fanOn ? '2px solid #FF9800' : '';
        }
    }

    updateSecurity(isArmed, hasMotion) {
        const pirElement       = document.getElementById('pirStatus');
        const motionElement    = document.getElementById('motionStatus');
        const pirSensorElement = document.getElementById('pirSensorStatus');

        if (pirElement) {
            pirElement.textContent = isArmed ? 'ARMED' : 'DISARMED';
            pirElement.className = 'alert-status ' + (isArmed ? 'bg-danger' : 'bg-success');
        }
        if (motionElement) {
            motionElement.textContent = (hasMotion === 1 ? 'MOTION DETECTED!' : 'No Motion');
            motionElement.className = 'alert-status ' + (hasMotion === 1 ? 'bg-danger' : 'bg-success');
        }
        if (pirSensorElement) {
            pirSensorElement.textContent = isArmed ? 'Enabled' : 'Disabled';
            pirSensorElement.className = 'alert-status ' + (isArmed ? 'bg-success' : 'bg-secondary');
        }
    }

    updateValve(type, isClosed) {
        const statusElement = document.getElementById(type + 'ValveStatus');
        if (!statusElement) return;

        if (type === 'water') this.flags.waterValveClosed = !!isClosed;
        if (type === 'gas')   this.flags.gasValveClosed   = !!isClosed;

        if (isClosed) {
            statusElement.textContent = 'CLOSED';
            statusElement.className = 'alert-status bg-danger';
        } else {
            statusElement.textContent = 'OPEN';
            statusElement.className = 'alert-status bg-success';
        }
    }

    updateSensorToggle(type, enabled) {
        const idMap = {
            water: 'waterSensorToggleStatus',
            flame: 'flameSensorToggleStatus',
            gas:   'gasSensorToggleStatus'
        };

        const statusElement = document.getElementById(idMap[type]);
        if (!statusElement) return;
        if (typeof enabled === 'undefined' || enabled === null) return;

        if (type === 'water') this.flags.waterSensorEnabled = !!enabled;
        if (type === 'flame') this.flags.flameSensorEnabled = !!enabled;
        if (type === 'gas')   this.flags.gasSensorEnabled   = !!enabled;

        if (enabled) {
            statusElement.innerHTML = '<i class="fas fa-lock-open"></i> Enabled';
            statusElement.className = 'alert-status bg-success';
        } else {
            statusElement.innerHTML = '<i class="fas fa-lock"></i> Disabled';
            statusElement.className = 'alert-status bg-secondary';
        }
    }

    updateSeen(isSeen) {
        const seenStatus = document.getElementById('seenStatus');

        this.seenEnabled = !!isSeen;

        if (seenStatus) {
            if (this.seenEnabled) {
                seenStatus.textContent = 'ENABLED';
                seenStatus.className = 'alert-status bg-success';
            } else {
                seenStatus.textContent = 'DISABLED';
                seenStatus.className = 'alert-status bg-secondary';
            }
        }
    }

    updateRtc(status) {
        const rtcBox = document.getElementById('rtcData');
        if (!rtcBox) return;

        let text = '';

        if (status.rtc_string) {
            text = status.rtc_string;
        } else if (status.rtc) {
            text = status.rtc;
        } else if (status.timestamp) {
            text = `Timestamp: ${status.timestamp}`;
        } else {
            text = 'Last update: ' + new Date().toLocaleString();
        }

        rtcBox.textContent = text;
    }

    updateConnectionStatus(connected) {
        const statusElement   = document.getElementById('connectionStatus');
        const mqttElement     = document.getElementById('mqttStatus');

        this.isConnected = connected;

        if (connected) {
            if (statusElement) {
                statusElement.innerHTML = '<i class="fas fa-wifi"></i> Connected';
                statusElement.className = 'badge bg-success';
            }
            if (mqttElement) {
                mqttElement.textContent = 'Connected';
                mqttElement.className = 'alert-status bg-success';
            }
        } else {
            if (statusElement) {
                statusElement.innerHTML = '<i class="fas fa-wifi-slash"></i> Disconnected';
                statusElement.className = 'badge bg-danger';
            }
            if (mqttElement) {
                mqttElement.textContent = 'Disconnected';
                mqttElement.className = 'alert-status bg-danger';
            }
        }

        const controlButtons = [
            'armPir','disarmPir','enablePir','disablePir',
            'openWaterValve','closeWaterValve','openGasValve','closeGasValve',
            'enableWaterSensor','disableWaterSensor',
            'enableFlameSensor','disableFlameSensor',
            'enableGasSensor','disableGasSensor'
        ];

        controlButtons.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = !connected;
        });
    }

    publishCommand(command) {
        if (!this.client || !this.client.connected) {
            this.showNotification('Not connected to AegisCore system.', 'warning');
            return;
        }
        this.client.publish(COMMAND_TOPIC, command);
        console.log('Command sent:', command);
    }

    /* Event Listeners */
    setupEventListeners() {
        // PIR Arm / Disarm
        const armPirBtn   = document.getElementById('armPir');
        const disarmPirBtn= document.getElementById('disarmPir');
        if (armPirBtn)   armPirBtn.addEventListener('click', () => this.publishCommand("ARM_PIR"));
        if (disarmPirBtn)disarmPirBtn.addEventListener('click', () => this.publishCommand("DISARM_PIR"));

        // PIR Enable / Disable
        const enablePirBtn  = document.getElementById('enablePir');
        const disablePirBtn = document.getElementById('disablePir');
        if (enablePirBtn)  enablePirBtn.addEventListener('click', () => this.publishCommand("ENABLE_PIR"));
        if (disablePirBtn) disablePirBtn.addEventListener('click', () => this.publishCommand("DISABLE_PIR"));

        // Water valve
        const openWater = document.getElementById('openWaterValve');
        const closeWater= document.getElementById('closeWaterValve');
        if (openWater) {
            openWater.addEventListener('click', () => {
                if (this.flags.waterSensorEnabled === false) {
                    this.showNotification('⚠️ Cannot OPEN water valve while Water Sensor is DISABLED.', 'warning', 7000);
                    return;
                }
                this.publishCommand("OPEN_WATER_VALVE");
            });
        }
        if (closeWater) {
            closeWater.addEventListener('click', () => {
                this.publishCommand("CLOSE_WATER_VALVE");
            });
        }

        // Gas valve
        const openGas  = document.getElementById('openGasValve');
        const closeGas = document.getElementById('closeGasValve');
        if (openGas) {
            openGas.addEventListener('click', () => {
                if (this.flags.gasSensorEnabled === false || this.flags.flameSensorEnabled === false) {
                    this.showNotification('⚠️ Cannot OPEN gas valve while Gas or Flame Sensor is DISABLED.', 'warning', 7000);
                    return;
                }
                this.publishCommand("OPEN_GAS_VALVE");
            });
        }
        if (closeGas) {
            closeGas.addEventListener('click', () => {
                this.publishCommand("CLOSE_GAS_VALVE");
            });
        }

        // Water Sensor Enable/Disable
        const enableWaterSensorBtn  = document.getElementById('enableWaterSensor');
        const disableWaterSensorBtn = document.getElementById('disableWaterSensor');
        if (enableWaterSensorBtn) enableWaterSensorBtn.addEventListener('click', () => {
            this.publishCommand("ENABLE_WATER_SENSOR");
        });
        if (disableWaterSensorBtn) disableWaterSensorBtn.addEventListener('click', () => {
            if (this.flags.waterValveClosed === false) {
                this.showNotification('⚠️ Close Water Valve before disabling its sensor.', 'warning', 7000);
                return;
            }
            this.publishCommand("DISABLE_WATER_SENSOR");
        });

        // Flame Sensor Enable/Disable
        const enableFlameSensorBtn  = document.getElementById('enableFlameSensor');
        const disableFlameSensorBtn = document.getElementById('disableFlameSensor');
        if (enableFlameSensorBtn) enableFlameSensorBtn.addEventListener('click', () => {
            this.publishCommand("ENABLE_FLAME_SENSOR");
        });
        if (disableFlameSensorBtn) disableFlameSensorBtn.addEventListener('click', () => {
            if (this.flags.gasValveClosed === false) {
                this.showNotification('⚠️ Close Gas Valve before disabling Flame Sensor.', 'warning', 7000);
                return;
            }
            this.publishCommand("DISABLE_FLAME_SENSOR");
        });

        // Gas Sensor Enable/Disable
        const enableGasSensorBtn  = document.getElementById('enableGasSensor');
        const disableGasSensorBtn = document.getElementById('disableGasSensor');
        if (enableGasSensorBtn) enableGasSensorBtn.addEventListener('click', () => {
            this.publishCommand("ENABLE_GAS_SENSOR");
        });
        if (disableGasSensorBtn) disableGasSensorBtn.addEventListener('click', () => {
            if (this.flags.gasValveClosed === false) {
                this.showNotification('⚠️ Close Gas Valve before disabling Gas Sensor.', 'warning', 7000);
                return;
            }
            this.publishCommand("DISABLE_GAS_SENSOR");
        });

        // 🔔 Enable notifications button
        const enableNotifBtn = document.getElementById('enableNotificationsBtn');
        if (enableNotifBtn) {
            enableNotifBtn.addEventListener('click', () => {
                if (confirm('Enable browser notifications for AegisCore alerts?')) {
                    this.requestNotificationsPermission();
                }
            });
        }

        // ♻ Reset data button
        const resetDataBtn = document.getElementById('resetDataBtn');
        if (resetDataBtn) {
            resetDataBtn.addEventListener('click', () => this.resetAllData());
        }

        // Filters
        const dateInput = document.getElementById('dateSelector');
        const dataTypeSelector = document.getElementById('dataTypeSelector');
        const resolutionSelector = document.getElementById('chartResolution');

        if (dateInput) dateInput.addEventListener('change', () => this.refreshAnalytics());
        if (dataTypeSelector) dataTypeSelector.addEventListener('change', () => this.refreshAnalytics());
        if (resolutionSelector) resolutionSelector.addEventListener('change', () => this.refreshAnalytics());

        // Download chart buttons
        document.querySelectorAll('[data-download-chart]').forEach(btn => {
            btn.addEventListener('click', () => {
                const chartKey = btn.getAttribute('data-download-chart');
                this.downloadChart(chartKey);
            });
        });

        // Tabs
        const mainTabs = document.querySelectorAll('#mainTabs button[data-bs-toggle="tab"]');
        mainTabs.forEach(tab => {
            tab.addEventListener('shown.bs.tab', () => {
                this.refreshAnalytics();
            });
        });

        // 📡 Auto SEEN based on visibility (no button)
        document.addEventListener('visibilitychange', () => this.handleVisibilityChange());
    }

    // Auto SEEN ON/OFF depending on page visibility
    handleVisibilityChange() {
        if (!this.client || !this.client.connected) return;

        if (document.visibilityState === 'visible') {
            this.publishCommand("SEEN_ON");
            this.updateSeen(true);
        } else {
            this.publishCommand("SEEN_OFF");
            this.updateSeen(false);
        }
    }

    downloadChart(chartKey) {
        const chart = this.charts[chartKey];
        if (!chart) return;

        const imgData = chart.toBase64Image();
        const link = document.createElement('a');
        link.href = imgData;
        link.download = `${chartKey}_chart_${this.getSelectedDate()}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /* Alerts + Data Store */
    checkForAlerts(status) {
        if (status.water_leak) {
            this.showNotification('🚨 WATER LEAK DETECTED!', 'danger', 10000);
        }
        if (status.flame_leak) {
            this.showNotification('🔥 FLAME DETECTED!', 'danger', 10000);
        }
        if (status.gas_leak) {
            this.showNotification('⚠️ GAS LEAK DETECTED!', 'warning', 10000);
        }
        if (status.motion === 1 && status.pir_armed) {
            this.showNotification('🚨 INTRUDER ALERT! Motion detected while system is armed.', 'danger', 10000);
        }
    }

    storeSensorData(status) {
        const timestamp = new Date();
        const dataPoint = {
            timestamp: timestamp.toISOString(),
            time: timestamp.toLocaleTimeString(),
            date: timestamp.toLocaleDateString(),
            water: status.water,
            flame: status.flame,
            gas: status.gas,
            temperature: status.temp,
            motion: status.motion,
            water_leak: status.water_leak,
            flame_leak: status.flame_leak,
            gas_leak: status.gas_leak,
            pir_armed: status.pir_armed,
            fan: status.fan,
            valve_water_closed: status.valve_water_closed,
            valve_gas_closed: status.valve_gas_closed
        };

        const today = this.getCurrentDate();
        if (!this.dataStore.daily[today]) {
            this.dataStore.daily[today] = { detailed: [] };
        }
        this.dataStore.daily[today].detailed.push(dataPoint);
        
        if (this.dataStore.daily[today].detailed.length > 500) {
            this.dataStore.daily[today].detailed = this.dataStore.daily[today].detailed.slice(-500);
        }
        
        this.saveStoredData();
    }

    /* Analytics */
    refreshAnalytics() {
        const date = this.getSelectedDate();
        const type = this.getSelectedDataType();
        const resolution = this.getSelectedResolution();

        const dayData = (this.dataStore.daily[date] && this.dataStore.daily[date].detailed) || [];

        this.updateSummaryCards(dayData);
        this.renderMainDataTable(dayData, type);
        this.renderSensorTables(dayData);
        this.updateCharts(dayData, resolution);
    }

    updateSummaryCards(dayData) {
        const waterAlerts  = dayData.filter(d => d.water_leak).length;
        const flameAlerts  = dayData.filter(d => d.flame_leak).length;
        const gasAlerts    = dayData.filter(d => d.gas_leak).length;
        const motionEvents = dayData.filter(d => d.motion === 1).length;

        const w = document.getElementById('waterAlertsCount');
        const f = document.getElementById('flameAlertsCount');
        const g = document.getElementById('gasAlertsCount');
        const m = document.getElementById('motionEventsCount');

        if (w) w.textContent = waterAlerts;
        if (f) f.textContent = flameAlerts;
        if (g) g.textContent = gasAlerts;
        if (m) m.textContent = motionEvents;
    }

    renderMainDataTable(dayData, type) {
        const body = document.getElementById('dataTableBody');
        if (!body) return;

        body.innerHTML = '';

        if (!dayData.length) {
            body.innerHTML = '<tr><td colspan="5" class="text-center">No data available</td></tr>';
            return;
        }

        const ordered = [...dayData].reverse(); // آخر حاجة فوق

        const sensorsToShow = (type === 'all' || type === 'alerts')
            ? ['water','flame','gas','temperature','motion']
            : [type];

        ordered.forEach(record => {
            sensorsToShow.forEach(sensor => {
                let value, status, isAlert = false;
                let sensorName = sensor;

                if (sensor === 'water') {
                    value  = record.water;
                    isAlert= !!record.water_leak;
                    status = record.water_leak ? 'LEAK' : 'Normal';
                } else if (sensor === 'flame') {
                    value  = record.flame;
                    isAlert= !!record.flame_leak;
                    status = record.flame_leak ? 'FIRE' : 'Normal';
                } else if (sensor === 'gas') {
                    value  = record.gas;
                    isAlert= !!record.gas_leak;
                    status = record.gas_leak ? 'LEAK' : 'Normal';
                } else if (sensor === 'temperature') {
                    value  = record.temperature + '°C';
                    sensorName = 'temp';
                    status = record.fan ? 'FAN ON' : 'Normal';
                } else if (sensor === 'motion') {
                    value  = record.motion === 1 ? 'Detected' : 'No';
                    isAlert= (record.motion === 1 && record.pir_armed);
                    status = record.motion === 1 ? 'Detected' : 'No Motion';
                }

                if (type === 'alerts' && !isAlert) return;

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.time}</td>
                    <td>${sensorName.toUpperCase()}</td>
                    <td>${value}</td>
                    <td>
                        <span class="alert-status ${isAlert ? 'bg-danger' : 'bg-success'}">
                            ${status}
                        </span>
                    </td>
                    <td>
                        ${isAlert ? '<i class="fas fa-exclamation-triangle text-danger"></i>' : '<i class="fas fa-check text-success"></i>'}
                    </td>
                `;
                body.appendChild(tr);
            });
        });

        if (!body.children.length) {
            body.innerHTML = '<tr><td colspan="5" class="text-center">No data for this filter</td></tr>';
        }
    }

    renderSensorTables(dayData) {
        const waterBody  = document.getElementById('waterSensorData');
        const flameBody  = document.getElementById('flameSensorData');
        const gasBody    = document.getElementById('gasSensorData');
        const tempBody   = document.getElementById('tempSensorData');
        const motionBody = document.getElementById('motionSensorData');

        if (waterBody)  waterBody.innerHTML = '';
        if (flameBody)  flameBody.innerHTML = '';
        if (gasBody)    gasBody.innerHTML = '';
        if (tempBody)   tempBody.innerHTML = '';
        if (motionBody) motionBody.innerHTML = '';

        const ordered = [...dayData].reverse();

        ordered.forEach(record => {
            if (waterBody) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.date}</td>
                    <td>${record.time}</td>
                    <td>${record.water}</td>
                    <td>${record.water_leak ? 'LEAK' : 'Normal'}</td>
                    <td>${record.valve_water_closed ? 'CLOSED' : 'OPEN'}</td>
                `;
                waterBody.appendChild(tr);
            }

            if (flameBody) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.date}</td>
                    <td>${record.time}</td>
                    <td>${record.flame}</td>
                    <td>${record.flame_leak ? 'FIRE' : 'Normal'}</td>
                    <td>${record.valve_gas_closed ? 'CLOSED' : 'OPEN'}</td>
                `;
                flameBody.appendChild(tr);
            }

            if (gasBody) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.date}</td>
                    <td>${record.time}</td>
                    <td>${record.gas}</td>
                    <td>${record.gas_leak ? 'LEAK' : 'Normal'}</td>
                    <td>${record.valve_gas_closed ? 'CLOSED' : 'OPEN'}</td>
                `;
                gasBody.appendChild(tr);
            }

            if (tempBody) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.date}</td>
                    <td>${record.time}</td>
                    <td>${record.temperature}</td>
                    <td>${record.fan ? 'FAN ON' : 'Normal'}</td>
                `;
                tempBody.appendChild(tr);
            }

            if (motionBody) {
                const tr = document.createElement('tr');
                let alertType = 'None';
                if (record.motion === 1 && record.pir_armed)      alertType = 'INTRUDER';
                else if (record.motion === 1)                     alertType = 'Motion Only';

                tr.innerHTML = `
                    <td>${record.date}</td>
                    <td>${record.time}</td>
                    <td>${record.motion === 1 ? 'Yes' : 'No'}</td>
                    <td>${record.pir_armed ? 'ARMED' : 'DISARMED'}</td>
                    <td>${alertType}</td>
                `;
                motionBody.appendChild(tr);
            }
        });
    }

    /* Charts */
    initializeCharts() {
        const commonOptions = {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    labels: {
                        color: '#ffffff',
                        font: {
                            size: 12
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#b0b0c0',
                        maxTicksLimit: 10
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                },
                y: {
                    ticks: {
                        color: '#b0b0c0'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    }
                }
            }
        };

        const waterCtx  = document.getElementById('waterChart');
        const flameCtx  = document.getElementById('flameChart');
        const gasCtx    = document.getElementById('gasChart');
        const tempCtx   = document.getElementById('tempChart');
        const motionCtx = document.getElementById('motionChart');

        if (waterCtx) {
            this.charts.water = new Chart(waterCtx, {
                type: 'line',
                data: { 
                    labels: [], 
                    datasets: [{
                        label: 'Water Level',
                        data: [],
                        borderColor: '#1E88E5',
                        backgroundColor: 'rgba(30, 136, 229, 0.1)',
                        tension: 0.4,
                        fill: true
                    }] 
                },
                options: commonOptions
            });
        }
        if (flameCtx) {
            this.charts.flame = new Chart(flameCtx, {
                type: 'line',
                data: { 
                    labels: [], 
                    datasets: [{
                        label: 'Flame Detection',
                        data: [],
                        borderColor: '#C62828',
                        backgroundColor: 'rgba(198, 40, 40, 0.1)',
                        tension: 0.4,
                        fill: true
                    }] 
                },
                options: commonOptions
            });
        }
        if (gasCtx) {
            this.charts.gas = new Chart(gasCtx, {
                type: 'line',
                data: { 
                    labels: [], 
                    datasets: [{
                        label: 'Gas Level',
                        data: [],
                        borderColor: '#2E7D32',
                        backgroundColor: 'rgba(46, 125, 50, 0.1)',
                        tension: 0.4,
                        fill: true
                    }] 
                },
                options: commonOptions
            });
        }
        if (tempCtx) {
            this.charts.temp = new Chart(tempCtx, {
                type: 'line',
                data: { 
                    labels: [], 
                    datasets: [{
                        label: 'Temperature (°C)',
                        data: [],
                        borderColor: '#FF9800',
                        backgroundColor: 'rgba(255, 152, 0, 0.1)',
                        tension: 0.4,
                        fill: true
                    }] 
                },
                options: commonOptions
            });
        }
        if (motionCtx) {
            this.charts.motion = new Chart(motionCtx, {
                type: 'bar',
                data: { 
                    labels: [], 
                    datasets: [{
                        label: 'Motion Detected',
                        data: [],
                        backgroundColor: 'rgba(0, 180, 216, 0.6)',
                        borderColor: '#00B4D8',
                        borderWidth: 1
                    }] 
                },
                options: commonOptions
            });
        }
    }

    aggregateForResolution(dayData, resolution) {
        if (!dayData.length) {
            return {
                labels: [],
                water:  [],
                flame:  [],
                gas:    [],
                temp:   [],
                motion: []
            };
        }

        if (resolution === 'raw') {
            return {
                labels: dayData.map(d => d.time),
                water:  dayData.map(d => d.water),
                flame:  dayData.map(d => d.flame),
                gas:    dayData.map(d => d.gas),
                temp:   dayData.map(d => d.temperature),
                motion: dayData.map(d => d.motion)
            };
        }

        const groups = {};

        dayData.forEach(d => {
            let key;
            if (resolution === 'minute') {
                key = d.time.slice(0,5);          // HH:MM
            } else if (resolution === 'hour') {
                key = d.time.slice(0,2) + ':00';  // HH:00
            } else if (resolution === 'day') {
                key = 'Day average';
            } else {
                key = d.time;
            }

            if (!groups[key]) {
                groups[key] = {
                    count: 0,
                    sumWater: 0,
                    sumFlame: 0,
                    sumGas: 0,
                    sumTemp: 0,
                    sumMotion: 0
                };
            }

            groups[key].count++;
            groups[key].sumWater  += d.water;
            groups[key].sumFlame  += d.flame;
            groups[key].sumGas    += d.gas;
            groups[key].sumTemp   += d.temperature;
            groups[key].sumMotion += d.motion;
        });

        const keys = Object.keys(groups).sort();
        return {
            labels: keys,
            water:  keys.map(k => groups[k].sumWater  / groups[k].count),
            flame:  keys.map(k => groups[k].sumFlame  / groups[k].count),
            gas:    keys.map(k => groups[k].sumGas    / groups[k].count),
            temp:   keys.map(k => groups[k].sumTemp   / groups[k].count),
            motion: keys.map(k => groups[k].sumMotion / groups[k].count)
        };
    }

    updateCharts(dayData, resolution) {
        const agg = this.aggregateForResolution(dayData, resolution);

        if (this.charts.water) {
            this.charts.water.data.labels = agg.labels;
            this.charts.water.data.datasets[0].data = agg.water;
            this.charts.water.update('none');
        }
        if (this.charts.flame) {
            this.charts.flame.data.labels = agg.labels;
            this.charts.flame.data.datasets[0].data = agg.flame;
            this.charts.flame.update('none');
        }
        if (this.charts.gas) {
            this.charts.gas.data.labels = agg.labels;
            this.charts.gas.data.datasets[0].data = agg.gas;
            this.charts.gas.update('none');
        }
        if (this.charts.temp) {
            this.charts.temp.data.labels = agg.labels;
            this.charts.temp.data.datasets[0].data = agg.temp;
            this.charts.temp.update('none');
        }
        if (this.charts.motion) {
            this.charts.motion.data.labels = agg.labels;
            this.charts.motion.data.datasets[0].data = agg.motion;
            this.charts.motion.update('none');
        }
    }

    animateOnceOnLoad() {
        if (this._hasAnimatedOnLoad) return;
        
        const elements = document.querySelectorAll('[data-animate-child]');
        elements.forEach((el, index) => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(20px)';
            setTimeout(() => {
                el.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
                el.style.opacity = '1';
                el.style.transform = 'translateY(0)';
            }, index * 100);
        });
        
        this._hasAnimatedOnLoad = true;
    }
}

// Start app
window.addEventListener('DOMContentLoaded', () => {
    window.aegisCore = new AegisCore();
});


// ------------------- باقي كود الأنيميشن/الـ theme القديم بتاعك -------------------

// setTheme القديم بتاعك - سبته زي ما هو عشان ما أخبطش أي حاجة بتستخدمه
function setTheme(themeName) {
    const theme = themes[themeName];
    document.documentElement.style.setProperty('--background-dark', theme.backgroundDark);
    document.documentElement.style.setProperty('--background-medium', theme.backgroundMedium);
    document.documentElement.style.setProperty('--background-light', theme.backgroundLight);
    document.documentElement.style.setProperty('--text-primary', theme.textPrimary);
    document.documentElement.style.setProperty('--text-secondary', theme.textSecondary);
    
    localStorage.setItem('selectedTheme', themeName);
}

// تحميل الثيم المحفوظ
window.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('selectedTheme') || 'dark';
    setTheme(savedTheme);
});


// تفعيل أنيميشنات الدخول للعناصر
document.addEventListener('DOMContentLoaded', function() {
    // إخفاء شاشة التحميل
    const loadingScreen = document.createElement('div');
    loadingScreen.className = 'page-loading';
    loadingScreen.innerHTML = `
        <div class="loading-content">
            <div class="loading-logo">
                <i class="fas fa-shield-alt"></i> AEGISCORE
            </div>
            <div class="loading-bar"></div>
        </div>
    `;
    document.body.appendChild(loadingScreen);
    
    setTimeout(() => {
        loadingScreen.classList.add('hidden');
        setTimeout(() => {
            loadingScreen.remove();
        }, 500);
    }, 1500);
    
    // تفعيل أنيميشنات العناصر
    const animateElements = document.querySelectorAll('[data-animate-child]');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const element = entry.target;
                const delay = element.getAttribute('data-delay') || 0;
                
                setTimeout(() => {
                    element.style.animation = `fadeInUp 0.8s ${delay}s both`;
                    element.classList.add('entered');
                }, delay * 1000);
                
                observer.unobserve(element);
            }
        });
    }, {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    });
    
    animateElements.forEach((element, index) => {
        element.style.setProperty('--delay', `${0.1 * (index % 10)}s`);
        observer.observe(element);
    });
    
    // تأثيرات خاصة عند تمرير المؤشر
    const cards = document.querySelectorAll('.sensor-card, .btn, .nav-link');
    
    cards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.zIndex = '100';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.zIndex = '';
        });
    });
    
    // تأثيرات للأزرار عند النقر
    const buttons = document.querySelectorAll('.btn');
    
    buttons.forEach(button => {
        button.addEventListener('click', function() {
            this.classList.add('clicked');
            setTimeout(() => {
                this.classList.remove('clicked');
            }, 300);
        });
    });
    
    // تأثيرات للقيم الحساسة
    function checkCriticalValues() {
        const waterValue = parseInt(document.getElementById('waterValue').textContent);
        const flameValue = parseInt(document.getElementById('flameValue').textContent);
        const gasValue = parseInt(document.getElementById('gasValue').textContent);
        
        const waterCard = document.getElementById('waterSensorCard');
        const flameCard = document.getElementById('flameSensorCard');
        const gasCard = document.getElementById('gasSensorCard');
        
        if (waterValue > 500) {
            waterCard.classList.add('alert');
            waterCard.classList.add('critical');
        } else {
            waterCard.classList.remove('alert');
            waterCard.classList.remove('critical');
        }
        
        if (flameValue > 100) {
            flameCard.classList.add('alert');
            flameCard.classList.add('critical');
        } else {
            flameCard.classList.remove('alert');
            flameCard.classList.remove('critical');
        }
        
        if (gasValue > 300) {
            gasCard.classList.add('alert');
            gasCard.classList.add('critical');
        } else {
            gasCard.classList.remove('alert');
            gasCard.classList.remove('critical');
        }
    }
    
    setInterval(checkCriticalValues, 1000);
    
    // تأثيرات خاصة للاتصال (محاكاة)
    function updateConnectionStatusSim(connected) {
        const statusBadge = document.getElementById('connectionStatus');
        if (!statusBadge) return;
        
        if (connected) {
            statusBadge.className = 'badge bg-success';
            statusBadge.innerHTML = '<i class="fas fa-wifi"></i> Connected';
            statusBadge.style.animation = 'pulse 1s ease';
            setTimeout(() => {
                statusBadge.style.animation = '';
            }, 1000);
        } else {
            statusBadge.className = 'badge bg-danger';
            statusBadge.innerHTML = '<i class="fas fa-wifi-slash"></i> Disconnected';
            statusBadge.style.animation = 'pulse 0.5s ease 3';
            setTimeout(() => {
                statusBadge.style.animation = '';
            }, 1500);
        }
    }
    
    // محاكاة اتصال ناجح بعد ثانيتين (للتجربة فقط)
    setTimeout(() => {
        updateConnectionStatusSim(true);
    }, 2000);
});
