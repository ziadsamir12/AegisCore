// MQTT Configuration - HiveMQ Cloud via WebSocket
const MQTT_SERVER = "wss://614bc7bd073f4283a92bee028ccabaff.s1.eu.hivemq.cloud:8884/mqtt";
const STATUS_TOPIC  = "home/status";
const COMMAND_TOPIC = "home/command";

const MQTT_USER = "ESP32";
const MQTT_PASS = "Ziad1272009";
const CLIENT_ID = "aegiscore_web_" + Math.random().toString(16).substr(2, 8);

class AegisCore {
    constructor() {
        this.client = null;
        this.isConnected = false;
        this.currentStatus = {};

        this.reconnectInterval = null;
        this.notificationToast = null;
        this.seenEnabled = false;

        // Flags من آخر Status
        this.flags = {
            waterSensorEnabled: null,
            flameSensorEnabled: null,
            gasSensorEnabled: null,
            waterValveClosed: null,
            gasValveClosed: null
        };

        // تخزين بيانات اليوم
        this.dataStore = {
            daily: {}
        };

        // Charts
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

    /* ========= INIT ========= */
    initializeApp() {
        this.loadStoredData();
        this.setDefaultDateInput();
        this.setupEventListeners();
        this.initializeToast();
        this.initializeCharts();
        this.connectToMQTT();
        this.refreshAnalytics();
        this.animateOnceOnLoad();
    }

    /* ========= Storage ========= */
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

    getCurrentDate() {
        return new Date().toISOString().split('T')[0];
    }

    getCurrentTime() {
        return new Date().toLocaleTimeString();
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

    /* ========= Toast ========= */
    initializeToast() {
        try {
            this.notificationToast = new bootstrap.Toast(document.getElementById('notificationToast'));
        } catch (e) {
            console.warn('Bootstrap toast init failed', e);
            this.notificationToast = null;
        }
    }

    showNotification(message, type = 'danger', duration = 5000) {
        const toast = document.getElementById('notificationToast');
        const toastMessage = document.getElementById('toastMessage');
        if (!toast || !toastMessage) return;

        let bgClass = type;
        if (type === 'info') bgClass = 'primary';
        if (type === 'success') bgClass = 'success';
        toast.className = `notification-toast toast align-items-center text-white bg-${bgClass} border-0`;
        toastMessage.textContent = message;

        if (this.notificationToast) {
            this.notificationToast.show();
            setTimeout(() => this.notificationToast.hide(), duration);
        } else {
            console.log('Notification:', message);
        }
    }

    /* ========= MQTT ========= */
    connectToMQTT() {
        console.log('Connecting to:', MQTT_SERVER);

        this.client = mqtt.connect(MQTT_SERVER, {
            clientId: CLIENT_ID,
            username: MQTT_USER,
            password: MQTT_PASS,
            clean: true,
            reconnectPeriod: 5000
        });

        this.client.on('connect', () => {
            console.log('MQTT Connected!');
            this.updateConnectionStatus(true);
            this.client.subscribe(STATUS_TOPIC, (err) => {
                if (err) console.error('Subscribe error:', err);
                else console.log('Subscribed to:', STATUS_TOPIC);
            });
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

    /* ========= Handle MQTT Messages ========= */
    handleMessage(topic, payload) {
        console.log('MQTT RAW MESSAGE:', topic, payload);

        if (topic !== STATUS_TOPIC) return;

        // رسائل بسيطة زي "ESP32 ONLINE" بنطنشها
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

    /* ========= UI Updates ========= */
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
            cardElement.style.border = isLeak ? '2px solid #C62828' : '';
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
        const toggleBtn  = document.getElementById('toggleSeen');

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

        if (toggleBtn) {
            toggleBtn.disabled = !this.isConnected;
            if (this.seenEnabled) {
                toggleBtn.innerHTML = '<i class="fas fa-eye-slash"></i> Disable SEEN';
                toggleBtn.classList.remove('btn-success');
                toggleBtn.classList.add('btn-outline-light');
            } else {
                toggleBtn.innerHTML = '<i class="fas fa-eye"></i> Enable SEEN';
                toggleBtn.classList.add('btn-success');
                toggleBtn.classList.remove('btn-outline-light');
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
        } else if (status.date || status.time) {
            text = `Date: ${status.date || '-'} | Time: ${status.time || '-'}`;
        } else {
            text = 'Last update: ' + new Date().toLocaleString();
        }

        rtcBox.textContent = text;
    }

    updateConnectionStatus(connected) {
        const statusElement   = document.getElementById('connectionStatus');
        const mqttElement     = document.getElementById('mqttStatus');
        const toggleSeenBtn   = document.getElementById('toggleSeen');

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

        if (toggleSeenBtn) toggleSeenBtn.disabled = !connected;
    }

    publishCommand(command) {
        if (!this.client || !this.client.connected) {
            this.showNotification('Not connected to AegisCore system.', 'warning');
            return;
        }
        this.client.publish(COMMAND_TOPIC, command);
        console.log('Command sent:', command);
    }

    /* ========= Event Listeners ========= */
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

        // Sensors enable/disable
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

        // SEEN toggle
        const toggleSeenBtn = document.getElementById('toggleSeen');
        if (toggleSeenBtn) {
            toggleSeenBtn.addEventListener('click', () => {
                const command = this.seenEnabled ? "SEEN_OFF" : "SEEN_ON";
                this.publishCommand(command);
                this.updateSeen(!this.seenEnabled); // Optimistic
            });
        }

        // Date / Data type / Resolution
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

    /* ========= Alerts + Data Store ========= */
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
        this.saveStoredData();
    }

    /* ========= Analytics ========= */
    refreshAnalytics() {
        const date = this.getSelectedDate();
        const type = this.getSelectedDataType();
        const resolution = this.getSelectedResolution();

        const dayData = (this.dataStore.daily[date] && this.dataStore.daily[date].detailed) || [];

        this.updateSummaryCards(dayData);
        this.renderMainDataTable(dayData, type);
        this.renderDetailedTable(dayData);
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
                    value  = record.temperature;
                    status = record.fan ? 'FAN ON' : 'Normal';
                } else if (sensor === 'motion') {
                    value  = record.motion;
                    isAlert= (record.motion === 1 && record.pir_armed);
                    status = record.motion === 1 ? 'Detected' : 'No Motion';
                }

                if (type === 'alerts' && !isAlert) return;

                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${record.time}</td>
                    <td>${sensor.toUpperCase()}</td>
                    <td>${value}</td>
                    <td>
                        <span class="badge ${isAlert ? 'bg-danger' : 'bg-success'}">
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

    renderDetailedTable(dayData) {
        const body = document.getElementById('detailedDataBody');
        if (!body) return;
        body.innerHTML = '';

        if (!dayData.length) {
            body.innerHTML = '<tr><td colspan="7" class="text-center">No detailed data available</td></tr>';
            return;
        }

        const ordered = [...dayData].reverse(); // أحدث فوق
        ordered.forEach(record => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${record.timestamp}</td>
                <td>${record.water}</td>
                <td>${record.flame}</td>
                <td>${record.gas}</td>
                <td>${record.temperature}</td>
                <td>${record.motion === 1 ? 'Yes' : 'No'}</td>
                <td>${record.pir_armed ? 'Yes' : 'No'}</td>
            `;
            body.appendChild(tr);
        });
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

    /* ========= Charts ========= */
    initializeCharts() {
        const waterCtx  = document.getElementById('waterChart');
        const flameCtx  = document.getElementById('flameChart');
        const gasCtx    = document.getElementById('gasChart');
        const tempCtx   = document.getElementById('tempChart');
        const motionCtx = document.getElementById('motionChart');

        if (waterCtx) {
            this.charts.water = new Chart(waterCtx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Water', data: [] }] },
                options: { responsive: true }
            });
        }
        if (flameCtx) {
            this.charts.flame = new Chart(flameCtx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Flame', data: [] }] },
                options: { responsive: true }
            });
        }
        if (gasCtx) {
            this.charts.gas = new Chart(gasCtx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Gas', data: [] }] },
                options: { responsive: true }
            });
        }
        if (tempCtx) {
            this.charts.temp = new Chart(tempCtx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Temperature', data: [] }] },
                options: { responsive: true }
            });
        }
        if (motionCtx) {
            this.charts.motion = new Chart(motionCtx, {
                type: 'line',
                data: { labels: [], datasets: [{ label: 'Motion', data: [] }] },
                options: { responsive: true }
            });
        }
    }

    aggregateForResolution(dayData, resolution) {
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
            this.charts.water.update();
        }
        if (this.charts.flame) {
            this.charts.flame.data.labels = agg.labels;
            this.charts.flame.data.datasets[0].data = agg.flame;
            this.charts.flame.update();
        }
        if (this.charts.gas) {
            this.charts.gas.data.labels = agg.labels;
            this.charts.gas.data.datasets[0].data = agg.gas;
            this.charts.gas.update();
        }
        if (this.charts.temp) {
            this.charts.temp.data.labels = agg.labels;
            this.charts.temp.data.datasets[0].data = agg.temp;
            this.charts.temp.update();
        }
        if (this.charts.motion) {
            this.charts.motion.data.labels = agg.labels;
            this.charts.motion.data.datasets[0].data = agg.motion;
            this.charts.motion.update();
        }
    }

    /* ========= Animation ========= */
    animateOnceOnLoad() {
        if (this._hasAnimatedOnLoad) return;
        this._hasAnimatedOnLoad = true;

        const elements = document.querySelectorAll('[data-animate-child]');
        elements.forEach((el, idx) => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(14px)';
            setTimeout(() => {
                el.classList.add('enter-animate');
                setTimeout(() => {
                    el.classList.add('entered');
                }, 700);
            }, idx * 100);
        });
    }
}

// Start
window.addEventListener('load', () => {
    window.aegisCore = new AegisCore();
});
