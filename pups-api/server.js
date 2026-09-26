/**
 * Plush Pups API — standalone backend
 *
 * Single-file Express + Socket.IO server. The frontend is hosted separately
 * (Netlify), so this process serves the JSON API and the realtime socket only.
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/auth/login | /api/auth/logout      GET /api/auth/session
 *   GET  /api/public/config | /api/public/puppies
 *   POST /api/public/chat/init | /api/public/chat/send
 *   GET  /api/public/chat/messages
 *   *     /api/admin/*                           (Bearer token or admin_token cookie)
 *
 * Environment:
 *   PORT             port to bind (default 3000)
 *   DATA_DIR         writable dir for db.json (default: this directory)
 *   JWT_SECRET       signing secret for admin tokens — REQUIRED in production
 *   ADMIN_CODE       admin access code — REQUIRED in production
 *   GEMINI_API_KEY   enables AI replies; falls back to rule-based replies
 *   ALLOWED_ORIGINS  comma-separated CORS origins (default: *)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

/* ============================================================================
 * DATABASE
 * ==========================================================================*/

// Where db.json lives. Defaults to this directory (local dev / git).
// Set DATA_DIR on hosts with an ephemeral filesystem to point at a
// persistent volume, e.g. /var/data on Render.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(__dirname, 'db.json');

if (DATA_DIR !== __dirname) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE) && fs.existsSync(SEED_FILE)) {
    fs.copyFileSync(SEED_FILE, DB_FILE);
    console.log('Seeded persistent database from bundled db.json');
  }
}

const defaultData = {
  admin_settings: {
    business_id: 'biz_001',
    hashed_code: bcrypt.hashSync('admin123', 10),
    inactivity_timeout_mins: 30,
    jwt_secret: 'plush_pups_super_secret_jwt_key_' + Math.random().toString(36).substring(2)
  },
  business_info: {
    id: 'biz_001',
    name: 'Plush Pups by Reed',
    phone: '+1 (979) 346-6792',
    email: 'plushpupsbyreed08@gmail.com',
    hours: 'Mon - Sat: 9:00 AM - 7:00 PM EST | Sun: 10:00 AM - 5:00 PM EST',
    address: 'Reed Family Kennel, North Carolina, USA',
    health_guarantee: '2-Year Comprehensive Genetic Health Guarantee. All puppies arrive vaccinated, dewormed, and microchipped with a full vet health certificate.',
    shipping_policy: 'Flight Nanny delivery available nationwide directly to your local airport or door. Local pickup is also welcome by appointment.',
    about: 'We specialize in breeding premium, home-raised Toy Maltipoos, Cavapoos, and Miniature Poodles raised with love, care, and early socialization.'
  },
  whatsapp_settings: {
    business_id: 'biz_001',
    phone_number: '+19793466792',
    default_message: 'Hello! I am interested in adopting a puppy from Plush Pups by Reed.',
    enabled: true
  },
  chat_settings: {
    business_id: 'biz_001',
    widget_title: 'Plush Pups Concierge',
    primary_color: '#d97706',
    welcome_message: 'Hello! Welcome to Plush Pups by Reed! How can we help you find your dream puppy today?',
    auto_open_delay: 5,
    offline_message: 'We are currently offline. Leave a message and our team will get back to you right away!'
  },
  notifications_settings: {
    business_id: 'biz_001',
    sound_enabled: true,
    desktop_notifs: true,
    email_alerts: true
  },
  ai_knowledge: {
    business_id: 'biz_001',
    system_prompt: `You are Plush Pups AI, a friendly, knowledgeable, and professional customer concierge for "Plush Pups by Reed", a high-end commercial puppy breeder specializing in Cavapoos, Toy Maltipoos, and Miniature Poodles.

Guidelines:
1. Always be warm, enthusiastic, polite, and helpful when talking about puppies.
2. Answer questions accurately using the inventory of available puppies, pricing, health guarantee, adoption process, and shipping options.
3. If a customer asks to speak with a human, book an appointment, or request custom pricing, offer to connect them with a live human representative.
4. Keep answers concise, clear, and easy to read.`,
    faqs: []
  },
  puppies: [],
  orders: [],
  payments: [],
  customers: [],
  chats: [],
  messages: []
};

class DB {
  constructor() {
    this.data = defaultData;
    this.init();
  }

  init() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
        this.data = { ...defaultData, ...this.data };
      } catch (err) {
        console.error('Error reading db.json, using defaultData:', err.message);
        this.save();
      }
    } else {
      this.save();
    }
  }

  save() {
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Error writing to db.json:', err.message);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return this.data[key];
  }

  update(key, fn) {
    if (typeof fn === 'function') {
      this.data[key] = fn(this.data[key]);
      this.save();
    }
    return this.data[key];
  }
}

const db = new DB();

/* ============================================================================
 * AI ENGINE
 * ==========================================================================*/

/**
 * Clean markdown bold/header syntax so responses read like natural human chat
 */
function cleanHumanText(text) {
  if (!text) return '';
  return text
    .replace(/\*\*/g, '')
    .replace(/#{1,6}\s*/g, '')
    .replace(/---\s*/g, '')
    .replace(/_{1,2}/g, '')
    .trim();
}

/**
 * Call Gemini REST API for a given model
 */
function callGeminiAPI(model, apiKey, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 12000
      },
      (res) => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text && text.trim()) return resolve(text.trim());
            } catch (e) { }
          }
          reject(new Error(`Status ${res.statusCode}: ${data.substring(0, 100)}`));
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(postData);
    req.end();
  });
}

/**
 * Query Gemini AI with automatic fallback across models
 */
async function queryGemini(contents, systemInstructionText, apiKey) {
  const models = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash'];
  const postData = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstructionText }] },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
  });

  for (const model of models) {
    try {
      const text = await callGeminiAPI(model, apiKey, postData);
      if (text) return cleanHumanText(text);
    } catch (err) {
      console.warn(`[Gemini AI] Model ${model} failed, trying next: ${err.message}`);
    }
  }
  return null;
}

/**
 * Format conversation history into Gemini content array (alternating user/model)
 */
function formatHistory(sessionHistory, customerText) {
  const contents = [];
  const validMessages = (sessionHistory || []).slice(-8);

  for (const m of validMessages) {
    if (!m.text || !m.text.trim()) continue;
    const role = m.sender === 'customer' ? 'user' : 'model';
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts[0].text += '\n' + m.text.trim();
    } else {
      contents.push({ role, parts: [{ text: m.text.trim() }] });
    }
  }

  const trimmedText = customerText.trim();
  if (contents.length === 0 || contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: trimmedText }] });
  } else if (!contents[contents.length - 1].parts[0].text.includes(trimmedText)) {
    contents.push({ role: 'user', parts: [{ text: trimmedText }] });
  }

  return contents;
}

/**
 * Build rich system prompt with live inventory, images, page links, and business info
 */
function buildSystemPrompt() {
  const business = db.get('business_info') || {};
  const aiKnowledge = db.get('ai_knowledge') || {};
  const puppies = db.get('puppies') || [];

  const availablePuppies = puppies
    .filter(p => p.status === 'Available')
    .map(p => {
      const lines = [
        `- ${p.name} (${p.breed}, ${p.gender}): $${p.price?.toLocaleString()}`,
        `  Color: ${p.color} | Weight: ${p.weight || 'N/A'} | Born: ${p.birth_date || 'N/A'}`,
        `  About: ${p.description || ''}`,
        `  Photo: ${p.image_url || 'N/A'}`,
        `  Product page: ${p.page_url || 'N/A'}`,
        `  PupID: ${p.id}`
      ];
      return lines.join('\n');
    })
    .join('\n\n');

  const faqsList = (aiKnowledge.faqs || [])
    .map(f => `Q: ${f.question}\nA: ${f.answer}`)
    .join('\n\n');

  return `${aiKnowledge.system_prompt || 'You are Plush Pups AI, a warm, knowledgeable, and professional customer concierge for "Plush Pups by Reed".'}

BUSINESS DETAILS:
- Name: ${business.name || 'Plush Pups by Reed'}
- Phone/Text: ${business.phone || '+1 (979) 346-6792'}
- Email: ${business.email || 'plushpupsbyreed08@gmail.com'}
- Location: ${business.address || 'North Carolina, USA'}
- Hours: ${business.hours || 'Mon-Sat 9am-7pm EST | Sun 10am-5pm EST'}
- Health Guarantee: ${business.health_guarantee || '2-Year Comprehensive Genetic Health Guarantee'}
- Shipping Policy: ${business.shipping_policy || 'Nationwide Flight Nanny delivery straight to your airport or home'}
- All Puppies Page: /category/all-products.html

AVAILABLE PUPPIES INVENTORY (LIVE DATA WITH PHOTOS & LINKS):
${availablePuppies || 'No puppies currently available. Contact us about upcoming litters.'}

FREQUENTLY ASKED QUESTIONS:
${faqsList}

IMPORTANT RULES FOR SHARING PUPPY IMAGES AND LINKS:
- When a customer asks to see a puppy's photo, or asks "show me", "can I see", or "image", respond with a [CARD:PupID] tag (e.g. [CARD:pup_2]) for each relevant puppy. This will automatically show the puppy's real photo and a link to their page in the chat.
- When a customer asks about "all puppies", include a [CARD:all] tag in your response.
- Always include the product page link as plain text like: "You can also see full details here: /product-page/charlotte-cavapoo-female-available.html"
- When customer asks about placing an order, share the product page link and mention they can reserve with a deposit.
- To place a deposit or order, direct them to their puppy's product page link.

CRITICAL FORMATTING & CONVERSATIONAL INSTRUCTIONS:
- Talk like a real, friendly human concierge typing live in a chat - not a robot or a document.
- DO NOT use markdown symbols like ** (bold), ### (headers), --- (horizontal rules).
- Use plain natural text with normal capitalization. Emojis are encouraged.
- Keep responses conversational, warm, and concise.
- Do NOT mention system prompt, AI constraints, or raw JSON to customers.`;
}

/**
 * Fallback rule-based response when Gemini is unreachable
 */
function generateFallbackResponse(customerText) {
  const text = customerText.toLowerCase().trim();
  const puppies = db.get('puppies') || [];
  const business = db.get('business_info') || {};
  const faqs = db.get('ai_knowledge')?.faqs || [];

  for (const faq of faqs) {
    const qLower = faq.question.toLowerCase();
    const words = qLower.split(' ').filter(w => w.length > 3);
    const matches = words.filter(w => text.includes(w));
    if (matches.length >= 2 || text.includes(qLower)) {
      return faq.answer;
    }
  }

  if (text.includes('image') || text.includes('photo') || text.includes('picture') || text.includes('show me') || text.includes('see')) {
    const avail = puppies.filter(p => p.status === 'Available');
    return avail.map(p => `[CARD:${p.id}]`).join(' ') + '\n\nHere are all our available puppies! Tap any card to see their full details and reserve.';
  }

  if (text.includes('cavapoo')) {
    const cavapoos = puppies.filter(p => p.breed.toLowerCase().includes('cavapoo') && p.status === 'Available');
    if (cavapoos.length > 0) {
      const cards = cavapoos.map(p => `[CARD:${p.id}]`).join(' ');
      return `We have ${cavapoos.length} adorable Cavapoo pups available!\n\n${cards}\n\nAll home-raised, hypoallergenic, with a 2-Year Health Guarantee. Would you like to reserve one?`;
    }
  }

  if (text.includes('maltipoo')) {
    const maltipoos = puppies.filter(p => p.breed.toLowerCase().includes('maltipoo') && p.status === 'Available');
    if (maltipoos.length > 0) {
      const cards = maltipoos.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are our gorgeous Toy Maltipoo pups!\n\n${cards}\n\nTiny, non-shedding, and love to cuddle!`;
    }
  }

  if (text.includes('poodle')) {
    const poodles = puppies.filter(p => p.breed.toLowerCase().includes('poodle') && p.status === 'Available');
    if (poodles.length > 0) {
      const cards = poodles.map(p => `[CARD:${p.id}]`).join(' ');
      return `Here are our available Poodle pups!\n\n${cards}\n\nVery intelligent, friendly, and great with families!`;
    }
  }

  if (text.includes('available') || text.includes('all puppies') || text.includes('puppies')) {
    const avail = puppies.filter(p => p.status === 'Available');
    const cards = avail.map(p => `[CARD:${p.id}]`).join(' ');
    return `Here are all our available puppies right now!\n\n${cards}\n\nSee full details and place a deposit on any of their pages.`;
  }

  if (text.includes('order') || text.includes('reserve') || text.includes('deposit') || text.includes('buy')) {
    return `To reserve a puppy, just let me know which one you love and I'll share their page link where you can place your deposit! Here are who's available:\n\n${puppies.filter(p => p.status === 'Available').map(p => `- ${p.name} (${p.breed}) - $${p.price?.toLocaleString()} ${p.page_url}`).join('\n')}\n\nOr type "human" and our owner will walk you through everything personally!`;
  }

  if (text.includes('price') || text.includes('cost') || text.includes('how much')) {
    return `Our puppy prices range from $2,100 to $2,800 depending on breed and color. A deposit reserves your puppy. All adoptions include shots, deworming, microchip, and our 2-Year Health Guarantee!`;
  }

  if (text.includes('ship') || text.includes('deliver') || text.includes('flight') || text.includes('travel')) {
    return `${business.shipping_policy || 'We offer nationwide Flight Nanny delivery straight to your local airport or doorstep. Local pickup is also welcome by appointment!'}`;
  }

  return `Hey there! At Plush Pups by Reed, we have beautiful home-raised Cavapoos, Toy Maltipoos, and Miniature Poodles. Ask me anything about our puppies, shipping, pricing, or type "human" to speak directly with our owner!`;
}

/**
 * Main AI response generator
 */
async function generateAIResponse(customerText, sessionHistory = [], businessId = 'biz_001') {
  const text = (customerText || '').toLowerCase().trim();
  const business = db.get('business_info') || {};
  const aiKnowledge = db.get('ai_knowledge') || {};

  // 1. Human takeover keywords
  const humanKeywords = ['human', 'person', 'owner', 'talk to someone', 'real agent', 'representative', 'speak with someone', 'call me', 'phone number'];
  if (humanKeywords.some(k => text.includes(k))) {
    return {
      text: `Sure! I'll connect you with the owner right now. You can also call or text us at ${business.phone || '+1 (979) 346-6792'} or email ${business.email || 'plushpupsbyreed08@gmail.com'}.`,
      requestTakeover: true
    };
  }

  // 2. Gemini AI response
  const apiKey = aiKnowledge.gemini_api_key || process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const contents = formatHistory(sessionHistory, customerText);
      const systemPrompt = buildSystemPrompt();
      const aiReply = await queryGemini(contents, systemPrompt, apiKey);
      if (aiReply) {
        return { text: aiReply, requestTakeover: false };
      }
    } catch (err) {
      console.error('[AI Engine] Gemini error:', err.message);
    }
  }

  // 3. Fallback
  return { text: generateFallbackResponse(customerText), requestTakeover: false };
}

/* ============================================================================
 * APP
 * ==========================================================================*/

const app = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  credentials: allowedOrigins.includes('*') ? false : true
};

const io = new Server(server, { cors: corsOptions });

const PORT = process.env.PORT || 3000;

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Prevent search indexing headers for admin API and route
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

// Service banner — the frontend is hosted separately, so there is no index.html here
app.get('/', (req, res) => {
  res.json({
    service: 'Plush Pups API',
    docs: 'See README.md',
    endpoints: ['/api/health', '/api/public/config', '/api/public/puppies', '/api/auth/login', '/api/admin/*']
  });
});

/* ============================================================================
 * ADMIN CREDENTIALS
 *
 * Secrets are never read from the committed db.json. They come from the
 * environment so they cannot leak through version control.
 * ==========================================================================*/

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret) return secret;
  const settings = db.get('admin_settings') || {};
  if (settings.jwt_secret) return settings.jwt_secret;
  return crypto.randomBytes(32).toString('hex');
}

function verifyAdminCode(code) {
  const envCode = process.env.ADMIN_CODE;
  if (envCode) {
    const a = Buffer.from(envCode);
    const b = Buffer.from(String(code || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const settings = db.get('admin_settings') || {};
  if (settings.hashed_code) {
    try {
      return bcrypt.compareSync(String(code).trim(), settings.hashed_code);
    } catch (e) {
      return false;
    }
  }
  return false;
}

// Admin Authentication Middleware
const requireAdmin = (req, res, next) => {
  let token = req.cookies.admin_token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized admin access' });
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired admin session' });
  }
};

// Customer Session Verification Helper & Middleware
function getCustomerSession(req) {
  const businessId = req.headers['x-business-id'] || req.body?.businessId || req.query?.businessId || 'biz_001';
  const sessionToken = req.headers['x-session-token'] || req.body?.sessionToken || req.query?.sessionToken;
  const conversationId = req.headers['x-conversation-id'] || req.body?.conversationId || req.body?.sessionId || req.query?.conversationId || req.query?.sessionId;

  if (!sessionToken || !conversationId) return null;

  const chats = db.get('chats') || [];
  const session = chats.find(c =>
    (c.id === conversationId || c.conversation_id === conversationId) &&
    c.session_token === sessionToken &&
    (c.business_id || 'biz_001') === businessId
  );

  return session || null;
}

const requireCustomerSession = (req, res, next) => {
  const session = getCustomerSession(req);
  if (!session) {
    return res.status(403).json({ error: 'Access Denied: Invalid, missing, or unauthorized customer session token' });
  }
  req.customerSession = session;
  next();
};

/* ============================================================================
 * HEALTH CHECK
 * ==========================================================================*/

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

/* ============================================================================
 * AUTH API
 * ==========================================================================*/

app.post('/api/auth/login', (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  if (!verifyAdminCode(code)) {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const settings = db.get('admin_settings') || {};
  const token = jwt.sign(
    { role: 'admin', business_id: 'biz_001', auth_at: Date.now() },
    getJwtSecret(),
    { expiresIn: `${settings.inactivity_timeout_mins || 30}m` }
  );

  res.cookie('admin_token', token, {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    maxAge: (settings.inactivity_timeout_mins || 30) * 60 * 1000
  });

  return res.json({
    success: true,
    token,
    inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('admin_token');
  return res.json({ success: true, message: 'Logged out successfully' });
});

app.get('/api/auth/session', (req, res) => {
  let token = req.cookies.admin_token;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0] === 'Bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.json({ authenticated: false });
  }

  const settings = db.get('admin_settings') || {};
  try {
    jwt.verify(token, getJwtSecret());
    return res.json({
      authenticated: true,
      inactivity_timeout_mins: settings.inactivity_timeout_mins || 30
    });
  } catch (e) {
    return res.json({ authenticated: false });
  }
});

/* ============================================================================
 * PUBLIC CHAT WIDGET & CONFIG API
 * ==========================================================================*/

app.get('/api/public/config', (req, res) => {
  const businessId = req.query.businessId || 'biz_001';
  return res.json({
    chat_settings: db.get('chat_settings'),
    business_info: db.get('business_info'),
    whatsapp_settings: db.get('whatsapp_settings')
  });
});

// Public puppies list for the chat widget to render rich puppy cards
app.get('/api/public/puppies', (req, res) => {
  const puppies = (db.get('puppies') || []).map(p => ({
    id: p.id,
    name: p.name,
    breed: p.breed,
    gender: p.gender,
    price: p.price,
    color: p.color,
    weight: p.weight,
    status: p.status,
    image_url: p.image_url || '',
    page_url: p.page_url || '/category/all-products.html',
    description: p.description || ''
  }));
  return res.json(puppies);
});

// Initiate or restore private customer chat session securely
app.post('/api/public/chat/init', (req, res) => {
  const { conversationId, sessionId, sessionToken, name, email, businessId = 'biz_001' } = req.body;
  const targetConvId = conversationId || sessionId;

  let chats = db.get('chats') || [];
  let session = null;

  if (targetConvId && sessionToken) {
    session = chats.find(c =>
      (c.id === targetConvId || c.conversation_id === targetConvId) &&
      c.session_token === sessionToken &&
      (c.business_id || 'biz_001') === businessId
    );
  }

  if (!session) {
    // Create new secure private conversation with unique IDs & cryptographic token
    const newConvId = 'conv_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const newCustId = 'cust_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const newSessionToken = crypto.randomBytes(32).toString('hex');

    session = {
      id: newConvId,
      conversation_id: newConvId,
      customer_id: newCustId,
      business_id: businessId,
      session_token: newSessionToken,
      customer_name: name || 'Guest Visitor',
      customer_email: email || '',
      mode: 'ai',
      status: 'active',
      unread_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    chats.unshift(session);
    db.set('chats', chats);

    // Initial Welcome Message
    const chatSettings = db.get('chat_settings') || {};
    const welcomeMsg = {
      id: 'msg_' + Date.now(),
      conversation_id: newConvId,
      session_id: newConvId,
      customer_id: newCustId,
      business_id: businessId,
      sender: 'ai',
      sender_name: 'Plush Pups AI',
      text: chatSettings.welcome_message || 'Hello! Welcome to Plush Pups by Reed! How can we help you find your dream puppy today?',
      timestamp: new Date().toISOString(),
      read: true
    };
    const messages = db.get('messages') || [];
    messages.push(welcomeMsg);
    db.set('messages', messages);
  } else {
    // Update contact info if provided
    if (name) session.customer_name = name;
    if (email) session.customer_email = email;
    session.updated_at = new Date().toISOString();
    db.set('chats', chats);
  }

  const sessionMessages = (db.get('messages') || []).filter(m =>
    (m.conversation_id || m.session_id) === (session.conversation_id || session.id) &&
    (m.business_id || 'biz_001') === businessId
  );

  return res.json({
    conversation: session,
    sessionToken: session.session_token,
    messages: sessionMessages
  });
});

// Fetch private customer messages (Requires valid sessionToken matching conversation)
app.get('/api/public/chat/messages', requireCustomerSession, (req, res) => {
  const session = req.customerSession;
  const sessionMessages = (db.get('messages') || []).filter(m =>
    (m.conversation_id || m.session_id) === (session.conversation_id || session.id)
  );
  return res.json({ conversation: session, messages: sessionMessages });
});

// Send public customer message (Requires valid sessionToken matching conversation)
app.post('/api/public/chat/send', requireCustomerSession, async (req, res) => {
  const session = req.customerSession;
  const { text, senderName } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Message text required' });
  }

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  const customerMsg = {
    id: 'msg_' + Date.now(),
    conversation_id: convId,
    session_id: convId,
    customer_id: session.customer_id,
    business_id: bizId,
    sender: 'customer',
    sender_name: senderName || session.customer_name || 'Customer',
    text: text.trim(),
    timestamp: new Date().toISOString(),
    read: false
  };

  let messages = db.get('messages') || [];
  messages.push(customerMsg);

  let chats = db.get('chats') || [];
  const idx = chats.findIndex(c => (c.id || c.conversation_id) === convId);
  if (idx !== -1) {
    chats[idx].updated_at = new Date().toISOString();
    chats[idx].unread_count = (chats[idx].unread_count || 0) + 1;
    session.updated_at = chats[idx].updated_at;
    session.unread_count = chats[idx].unread_count;
    db.set('chats', chats);
  }
  db.set('messages', messages);

  // Broadcast ONLY to the customer's private room and the business admin room
  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io.to(roomConv).to(roomAdmin).emit('chat:message', customerMsg);
  io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);

  let aiReplyMsg = null;

  // If chat is in 'ai' mode, generate isolated AI response
  if (session.mode === 'ai') {
    const sessionHistory = messages.filter(m => (m.conversation_id || m.session_id) === convId);
    const aiResult = await generateAIResponse(text, sessionHistory, bizId);

    if (aiResult.requestTakeover) {
      session.mode = 'human';
      if (idx !== -1) chats[idx].mode = 'human';
      db.set('chats', chats);
      io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);
      io.to(roomAdmin).emit('chat:takeover_requested', {
        conversationId: convId,
        customerName: session.customer_name
      });
    }

    aiReplyMsg = {
      id: 'msg_' + (Date.now() + 1),
      conversation_id: convId,
      session_id: convId,
      customer_id: session.customer_id,
      business_id: bizId,
      sender: 'ai',
      sender_name: 'Plush Pups AI',
      text: aiResult.text,
      timestamp: new Date().toISOString(),
      read: true
    };

    messages.push(aiReplyMsg);
    db.set('messages', messages);

    setTimeout(() => {
      io.to(roomConv).to(roomAdmin).emit('chat:message', aiReplyMsg);
    }, 400);
  }

  return res.json({ customerMsg, aiReplyMsg, conversation: session });
});

/* ============================================================================
 * PROTECTED ADMIN API
 * ==========================================================================*/

// 1. Live Chats
app.get('/api/admin/chats', requireAdmin, (req, res) => {
  const businessId = req.query.businessId || 'biz_001';
  const chats = (db.get('chats') || []).filter(c => (c.business_id || 'biz_001') === businessId);
  const messages = (db.get('messages') || []).filter(m => (m.business_id || 'biz_001') === businessId);
  return res.json({ chats, messages });
});

app.post('/api/admin/chats/:sessionId/mode', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  const { mode } = req.body; // 'ai' or 'human'

  let chats = db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  session.mode = mode === 'human' ? 'human' : 'ai';
  session.updated_at = new Date().toISOString();
  db.set('chats', chats);

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  const systemMsg = {
    id: 'msg_' + Date.now(),
    conversation_id: convId,
    session_id: convId,
    customer_id: session.customer_id,
    business_id: bizId,
    sender: 'human',
    sender_name: 'System',
    text: mode === 'human' ? 'Admin took over the live chat.' : 'AI Assistant has resumed the chat.',
    timestamp: new Date().toISOString(),
    read: true
  };
  let messages = db.get('messages') || [];
  messages.push(systemMsg);
  db.set('messages', messages);

  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);
  io.to(roomConv).to(roomAdmin).emit('chat:message', systemMsg);

  return res.json({ success: true, session });
});

app.post('/api/admin/chats/:sessionId/reply', requireAdmin, (req, res) => {
  const { sessionId } = req.params;
  const { text } = req.body;

  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required' });

  let chats = db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const convId = session.conversation_id || session.id;
  const bizId = session.business_id || 'biz_001';

  session.mode = 'human';
  session.unread_count = 0;
  session.updated_at = new Date().toISOString();

  const adminMsg = {
    id: 'msg_' + Date.now(),
    conversation_id: convId,
    session_id: convId,
    customer_id: session.customer_id,
    business_id: bizId,
    sender: 'human',
    sender_name: 'Admin Concierge',
    text: text.trim(),
    timestamp: new Date().toISOString(),
    read: true
  };

  let messages = db.get('messages') || [];
  messages.push(adminMsg);

  db.set('chats', chats);
  db.set('messages', messages);

  const roomConv = `room:conv_${convId}`;
  const roomAdmin = `room:admin_${bizId}`;

  io.to(roomConv).to(roomAdmin).emit('chat:message', adminMsg);
  io.to(roomConv).to(roomAdmin).emit('chat:session_updated', session);

  return res.json({ success: true, message: adminMsg, session });
});

app.delete('/api/admin/chats/:sessionId', requireAdmin, (req, res) => {
  const { sessionId } = req.params;

  let chats = db.get('chats') || [];
  let session = chats.find(c => (c.id || c.conversation_id) === sessionId);

  chats = chats.filter(c => (c.id || c.conversation_id) !== sessionId);
  db.set('chats', chats);

  if (session) {
    const convId = session.conversation_id || session.id;
    const bizId = session.business_id || 'biz_001';
    io.to(`room:admin_${bizId}`).to(`room:conv_${convId}`).emit('chat:session_deleted', { conversationId: convId });
  }

  return res.json({ success: true });
});

// 2. Customers CRM
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  return res.json(db.get('customers') || []);
});

app.post('/api/admin/customers', requireAdmin, (req, res) => {
  const newCust = {
    id: 'cust_' + Date.now(),
    business_id: 'biz_001',
    created_at: new Date().toISOString(),
    ...req.body
  };
  const customers = db.get('customers') || [];
  customers.unshift(newCust);
  db.set('customers', customers);
  return res.json(newCust);
});

app.put('/api/admin/customers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let customers = db.get('customers') || [];
  const idx = customers.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Customer not found' });
  customers[idx] = { ...customers[idx], ...req.body };
  db.set('customers', customers);
  return res.json(customers[idx]);
});

app.delete('/api/admin/customers/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let customers = db.get('customers') || [];
  customers = customers.filter(c => c.id !== id);
  db.set('customers', customers);
  return res.json({ success: true });
});

// 3. Puppies Inventory
app.get('/api/admin/puppies', requireAdmin, (req, res) => {
  return res.json(db.get('puppies') || []);
});

app.post('/api/admin/puppies', requireAdmin, (req, res) => {
  const newPup = {
    id: 'pup_' + Date.now(),
    business_id: 'biz_001',
    status: 'Available',
    ...req.body
  };
  const puppies = db.get('puppies') || [];
  puppies.unshift(newPup);
  db.set('puppies', puppies);
  return res.json(newPup);
});

app.put('/api/admin/puppies/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let puppies = db.get('puppies') || [];
  const idx = puppies.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Puppy not found' });
  puppies[idx] = { ...puppies[idx], ...req.body };
  db.set('puppies', puppies);
  return res.json(puppies[idx]);
});

app.delete('/api/admin/puppies/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let puppies = db.get('puppies') || [];
  puppies = puppies.filter(p => p.id !== id);
  db.set('puppies', puppies);
  return res.json({ success: true });
});

// 4. Orders
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  return res.json(db.get('orders') || []);
});

app.post('/api/admin/orders', requireAdmin, (req, res) => {
  const newOrder = {
    id: 'ord_' + Date.now(),
    business_id: 'biz_001',
    order_number: 'ORD-2026-' + Math.floor(1000 + Math.random() * 9000),
    created_at: new Date().toISOString(),
    status: 'Pending',
    payment_status: 'Unpaid',
    ...req.body
  };
  const orders = db.get('orders') || [];
  orders.unshift(newOrder);
  db.set('orders', orders);
  return res.json(newOrder);
});

app.put('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  let orders = db.get('orders') || [];
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Order not found' });
  orders[idx] = { ...orders[idx], ...req.body };
  db.set('orders', orders);
  return res.json(orders[idx]);
});

// 5. Payments
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  return res.json(db.get('payments') || []);
});

app.post('/api/admin/payments', requireAdmin, (req, res) => {
  const newPay = {
    id: 'pay_' + Date.now(),
    business_id: 'biz_001',
    date: new Date().toISOString(),
    status: 'Success',
    ...req.body
  };
  const payments = db.get('payments') || [];
  payments.unshift(newPay);
  db.set('payments', payments);
  return res.json(newPay);
});

// 6. AI Knowledge
app.get('/api/admin/knowledge', requireAdmin, (req, res) => {
  return res.json(db.get('ai_knowledge') || {});
});

app.put('/api/admin/knowledge', requireAdmin, (req, res) => {
  const updated = db.set('ai_knowledge', req.body);
  return res.json(updated);
});

// 7. Business Info
app.get('/api/admin/business', requireAdmin, (req, res) => {
  return res.json(db.get('business_info') || {});
});

app.put('/api/admin/business', requireAdmin, (req, res) => {
  const updated = db.set('business_info', req.body);
  return res.json(updated);
});

// 8. WhatsApp Settings
app.get('/api/admin/whatsapp', requireAdmin, (req, res) => {
  return res.json(db.get('whatsapp_settings') || {});
});

app.put('/api/admin/whatsapp', requireAdmin, (req, res) => {
  const updated = db.set('whatsapp_settings', req.body);
  return res.json(updated);
});

// 9. Chat Settings
app.get('/api/admin/chat-settings', requireAdmin, (req, res) => {
  return res.json(db.get('chat_settings') || {});
});

app.put('/api/admin/chat-settings', requireAdmin, (req, res) => {
  const updated = db.set('chat_settings', req.body);
  io.emit('chat:config_updated', updated);
  return res.json(updated);
});

// 10. Notifications Settings
app.get('/api/admin/notifications', requireAdmin, (req, res) => {
  return res.json(db.get('notifications_settings') || {});
});

app.put('/api/admin/notifications', requireAdmin, (req, res) => {
  const updated = db.set('notifications_settings', req.body);
  return res.json(updated);
});

// 11. Admin Security Settings
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const settings = db.get('admin_settings') || {};
  return res.json({
    inactivity_timeout_mins: settings.inactivity_timeout_mins || 30,
    code_source: process.env.ADMIN_CODE ? 'env' : 'db'
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const { newCode, inactivityTimeoutMins } = req.body;
  let settings = db.get('admin_settings') || {};

  if (newCode && newCode.trim().length >= 4) {
    if (process.env.ADMIN_CODE) {
      return res.status(409).json({
        error: 'Admin code is managed by the ADMIN_CODE environment variable and cannot be changed here'
      });
    }
    settings.hashed_code = bcrypt.hashSync(newCode.trim(), 10);
  }

  if (inactivityTimeoutMins && !isNaN(inactivityTimeoutMins)) {
    settings.inactivity_timeout_mins = parseInt(inactivityTimeoutMins, 10);
  }

  db.set('admin_settings', settings);
  return res.json({ success: true, inactivity_timeout_mins: settings.inactivity_timeout_mins });
});

/* ============================================================================
 * REALTIME SOCKET.IO PRIVATE ROOM ARCHITECTURE
 * ==========================================================================*/

io.on('connection', (socket) => {
  // Secure Customer Room Join
  socket.on('join:customer_conversation', (payload = {}) => {
    const { conversationId, sessionToken, businessId = 'biz_001' } = payload || {};
    if (!conversationId || !sessionToken) {
      return socket.emit('chat:error', { error: 'Missing conversation credentials' });
    }

    const chats = db.get('chats') || [];
    const session = chats.find(c =>
      (c.id === conversationId || c.conversation_id === conversationId) &&
      c.session_token === sessionToken &&
      (c.business_id || 'biz_001') === businessId
    );

    if (session) {
      const convId = session.conversation_id || session.id;
      socket.join(`room:conv_${convId}`);
      socket.emit('joined:success', { conversationId: convId });
    } else {
      socket.emit('chat:error', { error: 'Access Denied: Invalid customer session token' });
    }
  });

  // Secure Admin Room Join
  socket.on('join:admin', (payload = {}) => {
    const { adminToken, businessId = 'biz_001' } = payload || {};
    try {
      if (adminToken) {
        jwt.verify(adminToken, getJwtSecret());
        socket.join(`room:admin_${businessId}`);
        socket.emit('joined:admin_success', { businessId });
      } else {
        socket.emit('chat:error', { error: 'Admin token required' });
      }
    } catch (err) {
      socket.emit('chat:error', { error: 'Unauthorized or expired admin token' });
    }
  });
});

/* ============================================================================
 * START
 * ==========================================================================*/

if (!process.env.JWT_SECRET || !process.env.ADMIN_CODE) {
  console.warn('[config] JWT_SECRET and/or ADMIN_CODE are not set.');
  console.warn('[config] Admin access is unavailable until they are configured.');
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('====================================================');
    console.log('Plush Pups API');
    console.log(`Server listening on port ${PORT}`);
    console.log(`Database file: ${DB_FILE}`);
    console.log(`Gemini AI: ${process.env.GEMINI_API_KEY ? 'enabled' : 'disabled (rule-based replies)'}`);
    console.log('====================================================');
  });
}

module.exports = app;
