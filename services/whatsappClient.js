const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

console.log('🔄 Initializing WhatsApp Headless Client...');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n⚡ WhatsApp Login QR Code generated. Scan it below:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n✅ Headless WhatsApp Worker is ONLINE and authenticated!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp Authentication Failure:', msg);
});

client.initialize();

// Function to format and send WhatsApp message programmatically
async function sendWhatsAppMessage(phone, text) {
    if (!phone) return;
    try {
        let clean = phone.replace(/[^0-9]/g, "");
        if (clean.startsWith("0")) {
            clean = "94" + clean.slice(1);
        }
        const jid = clean.endsWith("@c.us") ? clean : `${clean}@c.us`;
        await client.sendMessage(jid, text);
        console.log(`✉️ WhatsApp message sent to ${jid}`);
    } catch (err) {
        console.error(`❌ Failed to send WhatsApp message to ${phone}:`, err);
    }
}

module.exports = { client, sendWhatsAppMessage };
