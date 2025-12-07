// server.js

const express = require('express');
const bodyParser = require('body-parser');
const webpush = require('web-push');
const mqtt = require('mqtt');
const cors = require('cors');
require('dotenv').config();   // <--- السطر الجديد المهم


// ====== 1) إعدادات عامة ======
const app  = express();
const PORT = 3000; // شغّل السيرفر على 3000 مثلاً

app.use(cors());
app.use(bodyParser.json());

// نخلي Express يخدم كل ملفات الواجهة من فولدر public
app.use(express.static("public"));

// ====== 2) VAPID keys (Web Push) ======
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails(
  'mailto:ziad.samir1272009@gmail.com',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// نخزن الـ subscriptions في الذاكرة (ديمو)
let subscriptions = [];

// ====== 3) API للاشتراك في Push ======
app.post('/subscribe', (req, res) => {
  const subscription = req.body;

  const exists = subscriptions.find(
    (sub) => JSON.stringify(sub) === JSON.stringify(subscription)
  );

  if (!exists) {
    subscriptions.push(subscription);
    console.log('New subscription stored. Total:', subscriptions.length);
  }

  res.status(201).json({ message: 'Subscription stored' });
});

// Endpoint بسيط تشوف منه public key في الواجهة
app.get('/vapidPublicKey', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ====== 4) MQTT Client ======
const STATUS_TOPIC = "home/status";
const MQTT_SERVER = process.env.MQTT_SERVER || "wss://614bc7bd073f4283a92bee028ccabaff.s1.eu.hivemq.cloud:8884/mqtt";
const MQTT_USER   = process.env.MQTT_USER;
const MQTT_PASS   = process.env.MQTT_PASS;

const CLIENT_ID = "aegiscore_backend_" + Math.random().toString(16).substr(2, 8);

const mqttClient = mqtt.connect(MQTT_SERVER, {
  clientId: CLIENT_ID,
  username: MQTT_USER,
  password: MQTT_PASS,
  clean: true,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log('[MQTT] Connected as backend');
  mqttClient.subscribe(STATUS_TOPIC, (err) => {
    if (err) console.error('[MQTT] Subscribe error:', err);
    else console.log('[MQTT] Subscribed to', STATUS_TOPIC);
  });
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Error:', err);
});

mqttClient.on('message', (topic, message) => {
  if (topic !== STATUS_TOPIC) return;

  let status;
  try {
    status = JSON.parse(message.toString());
  } catch (e) {
    console.error('[MQTT] JSON parse error:', e);
    return;
  }

  console.log('[MQTT] Status:', status);

  const alerts = [];

  if (status.water_leak) alerts.push('🚨 WATER LEAK DETECTED!');
  if (status.flame_leak) alerts.push('🔥 FLAME DETECTED!');
  if (status.gas_leak)   alerts.push('⚠️ GAS LEAK DETECTED!');
  if (status.motion === 1 && status.pir_armed) {
    alerts.push('🚨 INTRUDER ALERT! Motion detected while system is armed.');
  }

  if (alerts.length > 0) {
    const body = alerts.join(' | ');
    sendPushToAll({
      title: 'AegisCore Alert',
      body
    });
  }
});

// ====== 5) إرسال Push لكل الـ subscribers ======
function sendPushToAll(payload) {
  console.log('[PUSH] Sending notification to', subscriptions.length, 'subscribers');

  subscriptions.forEach((subscription, index) => {
    webpush.sendNotification(subscription, JSON.stringify(payload))
      .then(() => {
        console.log(`[PUSH] Sent to subscriber #${index + 1}`);
      })
      .catch(err => {
        console.error('[PUSH] Error sending to subscriber:', err.statusCode);

        if (err.statusCode === 410 || err.statusCode === 404) {
          subscriptions = subscriptions.filter(sub => sub !== subscription);
          console.log('[PUSH] Subscription removed. New total:', subscriptions.length);
        }
      });
  });
}

app.use(express.static(__dirname));
// ولو عندك ملفات جوه فولدر public برضه:
app.use('/public', express.static(__dirname + '/public'));


// ====== 6) Route رئيسية ترجع index.html ======
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// ====== 7) تشغيل السيرفر ======
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Public VAPID key:', VAPID_PUBLIC_KEY);
});
