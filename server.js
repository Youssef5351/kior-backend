import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import multer from "multer";
import path from "path";
import { PrismaClient } from "@prisma/client";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { URL } from 'url';
import AdmZip from 'adm-zip';
import busboy from 'busboy';
import duplicatesRoutes from './routes/duplicates.js';
import { put } from '@vercel/blob';

const transporter = nodemailer.createTransport({
  service: "gmail",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error("SMTP connection error:", error);
  } else {
    console.log("Server is ready to take our messages:", success);
  }
});

const prisma = new PrismaClient();
const app = express();



// Middlewares
app.use(cors({
  origin: ['https://kior.vercel.app', 'http://localhost:5173'], // Array with brackets
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Secret key for JWT
const JWT_SECRET = process.env.JWT_SECRET;
// Middleware to authenticate JWT token
const authenticateToken = (req, res, next) => {

  const authHeader = req.headers['authorization'];
  
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.log('❌ FAILED: No token provided');
    return res.status(401).json({ error: 'Access token required' });
  }


  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.log('❌ FAILED: Token verification error:', err.message);
      console.log('Error name:', err.name);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};
// const uploadDir = path.join(process.cwd(), "uploads");
// Conditional storage based on environment
const isDevelopment = process.env.NODE_ENV !== 'production';

// Only create upload directory in development
if (isDevelopment) {
  const uploadDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

app.use('/api/duplicates', authenticateToken, duplicatesRoutes);

// ✅ Multer config - use memory storage on Vercel
const storage = isDevelopment 
  ? multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, path.join(process.cwd(), "uploads"));
      },
      filename: (req, file, cb) => {
        cb(null, "articles" + path.extname(file.originalname));
      },
    })
  : multer.memoryStorage(); // Memory storage for Vercel

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const allowedExtensions = ['.nbib', '.ris', '.bib', '.zip', '.csv', '.enw', '.xml', '.ciw'];
    const fileExt = path.extname(file.originalname).toLowerCase();
    
    if (allowedExtensions.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${fileExt}. Only ${allowedExtensions.join(', ')} are allowed.`), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  }
});

// ✅ Upload route - handle both disk and memory storage
app.post("/upload", upload.single("file"), (req, res) => {
  console.log("File uploaded:", req.file);
  
  // In production (Vercel), file will be in req.file.buffer
  // In development, file will be in req.file.path
  
  res.json({ 
    success: true, 
    file: {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      // Don't send buffer in response, it's huge
      hasBuffer: !!req.file.buffer,
      path: req.file.path || 'in-memory'
    }
  });
});

// PDF upload configuration
const pdfStorage = isDevelopment
  ? multer.diskStorage({
      destination: (req, file, cb) => {
        const fulltextDir = 'uploads/fulltext/';
        if (!fs.existsSync(fulltextDir)) {
          fs.mkdirSync(fulltextDir, { recursive: true });
        }
        cb(null, fulltextDir);
      },
      filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
      },
    })
  : multer.memoryStorage(); // Memory storage for Vercel

const uploadPDF = multer({
  storage: pdfStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed for full-text uploads'), false);
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});
function normalizeTitle(title = "") {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}


function detectDuplicatesByTitleYear(articles) {
  // articles: array of { id, title, year, ... }
  // returns grouped duplicates + counts
  const map = new Map(); // key -> array of articles
  for (const a of articles) {
    const title = normalizeTitle(a.title || "");
    const year = a.year ? String(a.year) : "";
    const key = `${title}||${year}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(a);
  }

  const duplicateGroups = []; // each group is array length>1
  let duplicateCount = 0;     // number of extra items (if group=3 => contribute 2)
  for (const arr of map.values()) {
    if (arr.length > 1) {
      duplicateGroups.push(arr);
      duplicateCount += arr.length - 1;
    }
  }

  const totalArticles = articles.length;
  const notDuplicateCount = totalArticles - duplicateCount;
  const resolved = 0;
  const deleted = 0;

  return {
    duplicateGroups,          // grouped arrays of duplicates
    duplicatesFlat: duplicateGroups.flat(),
    totalDuplicates: duplicateCount,
    unresolved: duplicateCount,
    resolved,
    notDuplicate: notDuplicateCount,
    deleted,
  };
}

// Improved WebSocket connection with better error handling
const connectWebSocket = () => {
  if (!currentUser || !id) return;

  const token = localStorage.getItem('token');
  if (!token) {
    console.warn('No token available for WebSocket connection');
    return;
  }

  const wsUrl = `ws://localhost:5000?projectId=${id}&userId=${currentUser.id}&token=${token}`;
  
  console.log('Connecting to WebSocket:', wsUrl);
  
  try {
    wsRef.current = new WebSocket(wsUrl);
    
    wsRef.current.onopen = () => {
      console.log('WebSocket connected successfully');
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };
    
    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('WebSocket message received:', data);
        
        switch (data.type) {
          case 'SCREENING_UPDATE':
            if (data.decision) {
              handleScreeningUpdate(data.decision);
            }
            break;
          case 'BLIND_MODE_CHANGED':
            if (typeof data.blindMode === 'boolean') {
              setBlindMode(data.blindMode);
              console.log(`Blind mode ${data.blindMode ? 'enabled' : 'disabled'} by project owner`);
            }
            break;
          case 'PROJECT_SETTINGS_UPDATE':
            if (data.settings && typeof data.settings.blindMode === 'boolean') {
              setBlindMode(data.settings.blindMode);
            }
            break;
          case 'USER_JOINED':
          case 'USER_LEFT':
          case 'USERS_LIST':
            if (Array.isArray(data.users)) {
              setOnlineUsers(data.users);
            }
            break;
          default:
            console.log('Unknown WebSocket message type:', data.type);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error, 'Raw data:', event.data);
      }
    };
    
    wsRef.current.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      
      // Handle different close codes
      if (event.code === 1006) {
        console.log('WebSocket connection closed abnormally - server may be down');
      } else if (event.code === 1002) {
        console.log('WebSocket protocol error');
      }
      
      // Attempt reconnection with exponential backoff
      if (!reconnectTimeoutRef.current) {
        const reconnectDelay = Math.min(1000 * Math.pow(2, (reconnectTimeoutRef.attempts || 0)), 30000);
        console.log(`Attempting to reconnect WebSocket in ${reconnectDelay}ms...`);
        
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectTimeoutRef.attempts = (reconnectTimeoutRef.attempts || 0) + 1;
          connectWebSocket();
        }, reconnectDelay);
      }
    };
    
    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      
      // Check if the error is due to connection failure
      if (error.target.readyState === WebSocket.CLOSED) {
        console.log('WebSocket failed to connect - server may not be running or WebSocket endpoint not configured');
      }
    };
    
  } catch (error) {
    console.error('Failed to create WebSocket connection:', error);
  }
};
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });
const clients = new Map();
const projectClients = new Map(); // Map of projectId -> Set of clients

console.log('🚀 WebSocket server initializing...');

wss.on('connection', (ws, request) => {
  console.log('🔌 New WebSocket connection attempt');
  
  try {
    // Parse URL parameters
    const url = new URL(request.url, `http://${request.headers.host}`);
    const projectId = url.searchParams.get('projectId');
    const userId = url.searchParams.get('userId');
    const token = url.searchParams.get('token');
    
    console.log('Connection params:', { 
      projectId, 
      userId, 
      hasToken: !!token,
      tokenLength: token?.length 
    });
    
    // Validate required parameters
    if (!projectId || !userId || !token) {
      console.log('❌ Missing required parameters');
      ws.close(4000, 'Missing projectId, userId, or token');
      return;
    }

    // Verify JWT token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      console.log('✅ Token verified for user:', decoded.id);
    } catch (jwtError) {
      console.log('❌ JWT verification failed:', jwtError.message);
      ws.close(4001, 'Invalid or expired token');
      return;
    }
    
    // Check if token user matches the userId parameter
    if (decoded.id !== userId) {
      console.log('❌ Token userId mismatch');
      ws.close(4001, 'Token user mismatch');
      return;
    }

    // Store client info
    const clientInfo = {
      ws,
      userId,
      projectId,
      userEmail: decoded.email,
      connectedAt: new Date().toISOString()
    };
    
    clients.set(ws, clientInfo);
    
    // Add to project clients
    if (!projectClients.has(projectId)) {
      projectClients.set(projectId, new Set());
    }
    projectClients.get(projectId).add(ws);
    
    console.log(`✅ User ${userId} (${decoded.email}) connected to project ${projectId}`);
    console.log(`📊 Total clients: ${clients.size}, Project ${projectId} clients: ${projectClients.get(projectId).size}`);
    
    // Send connection success message
    ws.send(JSON.stringify({
      type: 'CONNECTION_SUCCESS',
      message: 'Successfully connected to WebSocket',
      userId,
      projectId
    }));
    
    // Get and broadcast current users in project
    const projectUsers = getProjectUsers(projectId);
    broadcastToProject(projectId, {
      type: 'USER_JOINED',
      users: projectUsers,
      newUser: { id: userId, email: decoded.email }
    });

    // Handle incoming messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        console.log(`📨 Message from ${userId}:`, message.type);
        handleWebSocketMessage(ws, message);
      } catch (error) {
        console.error('❌ Error parsing message:', error);
        ws.send(JSON.stringify({
          type: 'ERROR',
          message: 'Invalid message format'
        }));
      }
    });

    // Handle client disconnect
    ws.on('close', (code, reason) => {
      handleClientDisconnect(ws, code, reason?.toString());
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
      console.error('❌ WebSocket client error:', error);
      handleClientDisconnect(ws, 1011, 'Server error');
    });

  } catch (error) {
    console.error('❌ Connection setup error:', error);
    ws.close(4001, 'Server error during connection setup');
  }
});

// Handle WebSocket messages
function handleWebSocketMessage(ws, message) {
  const clientInfo = clients.get(ws);
  if (!clientInfo) {
    console.log('❌ Client info not found');
    return;
  }

  const { userId, projectId } = clientInfo;

  switch (message.type) {
    case 'SCREENING_DECISION':
      console.log(`📊 Screening decision from ${userId} for project ${projectId}`);
      broadcastToProject(projectId, {
        type: 'SCREENING_UPDATE',
        decision: {
          ...message.decision,
          userId,
          timestamp: new Date().toISOString()
        }
      }, ws); // Exclude sender
      break;

    case 'BLIND_MODE_UPDATE':
      console.log(`👁️ Blind mode update attempt by ${userId} for project ${projectId}`);
      // Add your blind mode update logic here
      broadcastToProject(projectId, {
        type: 'BLIND_MODE_CHANGED',
        projectId,
        blindMode: message.blindMode,
        updatedBy: userId
      });
      break;

    case 'PING':
      ws.send(JSON.stringify({ type: 'PONG' }));
      break;

    default:
      console.log('❓ Unknown message type:', message.type);
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: `Unknown message type: ${message.type}`
      }));
  }
}

// Handle client disconnect
function handleClientDisconnect(ws, code, reason) {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  const { userId, projectId } = clientInfo;
  
  console.log(`🔌 User ${userId} disconnected from project ${projectId}`);
  console.log(`📊 Disconnect code: ${code}, reason: ${reason}`);

  // Remove from clients map
  clients.delete(ws);

  // Remove from project clients
  const projectClientSet = projectClients.get(projectId);
  if (projectClientSet) {
    projectClientSet.delete(ws);
    if (projectClientSet.size === 0) {
      projectClients.delete(projectId);
    }
  }

  console.log(`📊 Remaining clients: ${clients.size}`);

  // Notify remaining users in the project
  const remainingUsers = getProjectUsers(projectId);
  broadcastToProject(projectId, {
    type: 'USER_LEFT',
    users: remainingUsers,
    leftUser: { id: userId }
  });
}

// Broadcast message to all clients in a project
function broadcastToProject(projectId, message, excludeClient = null) {
  const projectClientSet = projectClients.get(projectId);
  if (!projectClientSet) {
    console.log(`📡 No clients found for project ${projectId}`);
    return;
  }

  let sentCount = 0;
  const messageStr = JSON.stringify(message);

  projectClientSet.forEach(ws => {
    if (ws !== excludeClient && ws.readyState === ws.OPEN) {
      try {
        ws.send(messageStr);
        sentCount++;
      } catch (error) {
        console.error('❌ Error sending message to client:', error);
        // Remove dead connection
        projectClientSet.delete(ws);
        clients.delete(ws);
      }
    }
  });

  console.log(`📡 Broadcast "${message.type}" sent to ${sentCount} clients in project ${projectId}`);
}

// Get list of users in a project
function getProjectUsers(projectId) {
  const users = [];
  const projectClientSet = projectClients.get(projectId);
  
  if (projectClientSet) {
    projectClientSet.forEach(ws => {
      const clientInfo = clients.get(ws);
      if (clientInfo) {
        users.push({
          id: clientInfo.userId,
          email: clientInfo.userEmail,
          connectedAt: clientInfo.connectedAt
        });
      }
    });
  }
  
  return users;
}

// Add health check endpoint for WebSocket debugging
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    websocketConnections: clients.size,
    activeProjects: projectClients.size
  });
});



// --- end helpers ---
function parseNBIB(content) {
  const lines = content.split("\n");

  let article = {
    title: "",
    abstract: "",
    authors: [],
    year: null,
    date: null,
    journal: "",
    volume: "",
    issue: "",
    pages: "",
    doi: "",
    url: "",
    publicationTypes: [],
    topics: [],
    pmid: ""
  };
  let articles = [];
  let currentField = null;

  for (let line of lines) {
    // Start of new article
    if (line.startsWith("PMID-")) {
      // Save previous article if it has content
      if (article.title || article.authors.length || article.journal) {
        // Format journal info before saving
        article.journal = formatJournalInfo(article);
        articles.push(article);
      }
      
      // Reset for new article
      article = {
        title: "",
        abstract: "",
        authors: [],
        year: null,
        date: null,
        journal: "",
        volume: "",
        issue: "",
        pages: "",
        doi: "",
        url: "",
        publicationTypes: [],
        topics: [],
        pmid: ""
      };

      article.pmid = line.replace("PMID-", "").trim();
      article.url = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
      currentField = null;
      continue;
    }

    // Handle continuation lines (6+ spaces at start)
    if (/^\s{6,}/.test(line)) {
      const continuationText = line.trim();
      if (currentField === "abstract") {
        article.abstract += " " + continuationText;
      } else if (currentField === "title") {
        article.title += " " + continuationText;
      }
      continue;
    }

    // Title field
    if (line.startsWith("TI  -")) {
      article.title = line.replace("TI  -", "").trim();
      currentField = "title";
      continue;
    }

    // Abstract field - KEEP currentField active for continuation lines
    if (line.startsWith("AB  -")) {
      article.abstract = line.replace("AB  -", "").trim();
      currentField = "abstract";
      continue;
    }

    // Authors - collect all into array
    if (line.startsWith("AU  -")) {
      article.authors.push(line.replace("AU  -", "").trim());
      currentField = null; // Authors typically don't continue
      continue;
    }

    // Publication Types - collect all into array
    if (line.startsWith("PT  -")) {
      article.publicationTypes.push(line.replace("PT  -", "").trim());
      currentField = null;
      continue;
    }

    // MeSH terms/Topics - collect all into array
    if (line.startsWith("MH  -")) {
      article.topics.push(line.replace("MH  -", "").trim());
      currentField = null;
      continue;
    }

    // Journal title
    if (line.startsWith("JT  -")) {
      article.journal = line.replace("JT  -", "").trim();
      currentField = null;
      continue;
    }

    // Volume
    if (line.startsWith("VI  -")) {
      article.volume = line.replace("VI  -", "").trim();
      currentField = null;
      continue;
    }

    // Issue
    if (line.startsWith("IP  -")) {
      article.issue = line.replace("IP  -", "").trim();
      currentField = null;
      continue;
    }

    // Pages
    if (line.startsWith("PG  -")) {
      article.pages = line.replace("PG  -", "").trim();
      currentField = null;
      continue;
    }

    // DOI
    if (line.startsWith("LID -") && line.includes("doi")) {
      article.doi = line.replace("LID -", "").replace("[doi]", "").trim();
      currentField = null;
      continue;
    }

    // Date/Year
    if (line.startsWith("DP  -")) {
      const dateString = line.replace("DP  -", "").trim();
      
      // Extract year
      const yearMatch = dateString.match(/\d{4}/);
      article.year = yearMatch ? parseInt(yearMatch[0], 10) : null;
      
      // Try to parse full date
      try {
        // Handle different date formats
        if (dateString.match(/\d{4}\s+\w+\s+\d{1,2}/)) {
          // Format: "2022 Sep 1"
          article.date = new Date(dateString);
        } else if (dateString.match(/\d{4}/)) {
          // Just year
          article.date = new Date(article.year, 0, 1);
        }
      } catch (error) {
        article.date = null;
      }
      
      currentField = null;
      continue;
    }

    // REMOVED: The problematic line that was resetting currentField for every unmatched line
    // Only reset currentField when we encounter a new field tag that we don't specifically handle
    if (line.match(/^[A-Z]{2,4}\s*-/) && 
        !line.startsWith("TI  -") && 
        !line.startsWith("AB  -")) {
      currentField = null;
    }
  }

  // Don't forget the last article
  if (article.title || article.authors.length || article.journal) {
    article.journal = formatJournalInfo(article);
    articles.push(article);
  }

  return articles;
}
function parseRIS(content) {
  const lines = content.split(/\r?\n/);

  let article = createEmptyArticle();
  let articles = [];
  let currentTag = null;

  for (let line of lines) {
    if (!line.trim()) {
      currentTag = null;
      continue;
    }

    // Check if this is a tag line (format: "XX  - ")
    if (line.match(/^[A-Z][A-Z0-9]\s{2}-/)) {
      const tag = line.substring(0, 2);
      const value = line.substring(6).trim();
      
      currentTag = tag;

      switch (tag) {
        case "TY": // Start of new record
          // Save previous article if it has ANY data
          if (article.title || article.authors.length > 0 || article.doi || article.abstract) {
            article.journal = formatJournalInfo(article);
            articles.push(article);
          }
          article = createEmptyArticle();
          break;

        case "TI": // Title
          article.title = value;
          break;

        case "T2": // Secondary title (often used for journal name)
        case "JO": // Journal
        case "JF": // Journal full
          article.journal = value;
          break;

        case "AB": // Abstract
          article.abstract = value;
          break;

        case "AU": // Author
          article.authors.push(value);
          break;

        case "PY": // Publication Year
          const yearMatch = value.match(/\d{4}/);
          if (yearMatch) {
            article.year = parseInt(yearMatch[0], 10);
            article.date = new Date(article.year, 0, 1);
          }
          break;

        case "VL": // Volume
          article.volume = value;
          break;

        case "IS": // Issue
          article.issue = value;
          break;

        case "SP": // Start pages
          article.pages = value;
          break;

        case "EP": // End pages
          if (article.pages) {
            article.pages += '-' + value;
          } else {
            article.pages = value;
          }
          break;

        case "DO": // DOI
          article.doi = value;
          break;

        case "UR": // URL
          article.url = value;
          break;

        case "KW": // Keywords / Topics
          article.topics.push(value);
          break;

        case "SN": // ISSN
          if (!article.pmid && value.match(/^\d+$/) && value.length > 8) {
            article.pmid = value;
          }
          break;

        case "C2": // Citation ID (often contains PMID)
          if (!article.pmid && value.match(/^\d+$/)) {
            article.pmid = value;
          }
          break;

        case "ER": // End of record
          if (article.title || article.authors.length > 0 || article.doi || article.abstract) {
            article.journal = formatJournalInfo(article);
            articles.push(article);
          }
          article = createEmptyArticle();
          currentTag = null;
          break;
      }
    } else if (currentTag) {
      // This is a continuation line for the current tag
      const continuationValue = line.trim();
      if (continuationValue) {
        switch (currentTag) {
          case "TI": // Title continuation
            article.title += ' ' + continuationValue;
            break;
          case "AB": // Abstract continuation
            article.abstract += ' ' + continuationValue;
            break;
          case "T2":
          case "JO":
          case "JF": // Journal continuation
            article.journal += ' ' + continuationValue;
            break;
          case "KW": // Keywords continuation
            article.topics.push(continuationValue);
            break;
        }
      }
    }
  }

  // ✅ Push the last article if file didn't end with ER
  if (article.title || article.authors.length > 0 || article.doi || article.abstract) {
    article.journal = formatJournalInfo(article);
    articles.push(article);
  }

  return articles;
}
// ZIP file parser
async function parseZIPFile(zipFilePath) {
  const zip = new AdmZip(zipFilePath);
  const zipEntries = zip.getEntries();
  const allArticles = [];

  for (const entry of zipEntries) {
    if (!entry.isDirectory) {
      const fileName = entry.entryName.toLowerCase();
      
      try {
        const content = entry.getData().toString("utf8");
        let parsedArticles = [];

        if (fileName.endsWith(".nbib")) {
          parsedArticles = parseNBIB(content);
        } else if (fileName.endsWith(".ris")) {
          parsedArticles = parseRIS(content);
        } else if (fileName.endsWith(".bib")) {
          parsedArticles = parseBibTeX(content);
        } else if (fileName.endsWith(".csv")) {
          parsedArticles = parseCSV(content);
        } else {
          console.log(`Skipping unsupported file in ZIP: ${entry.entryName}`);
          continue;
        }

        if (parsedArticles && parsedArticles.length > 0) {
          // Add source file info
          parsedArticles.forEach(article => {
            article.sourceFile = `ZIP: ${entry.entryName}`;
          });
          allArticles.push(...parsedArticles);
        }
      } catch (error) {
        console.error(`Error processing ${entry.entryName} in ZIP:`, error);
      }
    }
  }

  return allArticles;
}

// Add CSV parsing function
function parseCSV(content) {
  try {
    const articles = [];
    const lines = content.split('\n').filter(line => line.trim());
    
    // Try to detect delimiter
    const firstLine = lines[0];
    let delimiter = ',';
    if (firstLine.includes('\t')) delimiter = '\t';
    else if (firstLine.includes(';')) delimiter = ';';
    
    // Extract headers
    const headers = firstLine.split(delimiter).map(h => h.trim().replace(/"/g, ''));
    
    // Process data rows
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const article = createEmptyArticle();
      const values = parseCSVLine(line, delimiter);
      
      // Map CSV columns to article fields
      headers.forEach((header, index) => {
        const value = values[index] ? values[index].trim().replace(/"/g, '') : '';
        
        switch (header.toLowerCase()) {
          case 'title':
          case 'article title':
          case 'document title':
            article.title = value;
            break;
            
          case 'abstract':
          case 'summary':
          case 'description':
            article.abstract = value;
            break;
            
          case 'authors':
          case 'author':
          case 'creators':
            if (value) {
              article.authors = value.split(';').map(a => a.trim()).filter(a => a);
            }
            break;
            
          case 'journal':
          case 'journal name':
          case 'source':
          case 'publication':
            article.journal = value;
            break;
            
          case 'year':
          case 'publication year':
          case 'date':
            if (value) {
              const yearMatch = value.match(/\d{4}/);
              article.year = yearMatch ? parseInt(yearMatch[0]) : null;
              if (article.year) {
                article.date = new Date(article.year, 0, 1);
              }
            }
            break;
            
          case 'volume':
          case 'vol':
            article.volume = value;
            break;
            
          case 'issue':
          case 'number':
            article.issue = value;
            break;
            
          case 'pages':
          case 'page':
            article.pages = value;
            break;
            
          case 'doi':
          case 'digital object identifier':
            article.doi = value;
            break;
            
          case 'url':
          case 'link':
          case 'urls':
            article.url = value;
            break;
            
          case 'pmid':
          case 'pubmed id':
            article.pmid = value;
            break;
            
          case 'keywords':
          case 'mesh headings':
          case 'topics':
            if (value) {
              article.topics = value.split(';').map(k => k.trim()).filter(k => k);
            }
            break;
            
          case 'publication type':
          case 'type':
            if (value) {
              article.publicationTypes = value.split(';').map(t => t.trim()).filter(t => t);
            }
            break;
        }
      });
      
      // Set URL if not provided but DOI is available
      if (!article.url && article.doi) {
        article.url = `https://doi.org/${article.doi}`;
      }
      
      // Set URL if not provided but PMID is available
      if (!article.url && article.pmid) {
        article.url = `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`;
      }
      
      // Format journal info
      article.journal = formatJournalInfo(article);
      
      // Only add if we have meaningful data
      if (article.title || article.authors.length > 0 || article.doi || article.pmid) {
        articles.push(article);
      }
    }
    
    return articles;
  } catch (error) {
    console.error('CSV parsing error:', error);
    return [];
  }
}

// Helper function to parse CSV line with quoted values
function parseCSVLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Start or end of quoted field
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      // End of field
      result.push(current);
      current = '';
    } else {
      // Regular character
      current += char;
    }
  }
  
  // Add the last field
  result.push(current);
  return result;
}

// BibTeX parser
function parseBibTeX(content) {
  try {
    const articles = [];
    
    // Remove comments and normalize line endings
    const cleanContent = content
      .replace(/%.*$/gm, '') // Remove comments
      .replace(/\r\n/g, '\n') // Normalize line endings
      .replace(/[ \t]+/g, ' ') // Normalize whitespace
      .trim();

    // Split into entries (entries start with @type{...})
    const entryRegex = /@(\w+)\s*{([^,]+),\s*([^}]*)}/g;
    let match;

    while ((match = entryRegex.exec(cleanContent)) !== null) {
      const entryType = match[1].toLowerCase();
      const citationKey = match[2].trim();
      const fieldsString = match[3].trim();

      // Only process article-like entries
      if (['article', 'inproceedings', 'conference', 'book', 'incollection', 'phdthesis', 'mastersthesis'].includes(entryType)) {
        const article = createEmptyArticle();
        
        // Parse fields
        const fields = parseBibTeXFields(fieldsString);
        
        // Map fields to article object
        article.title = fields.title || fields.booktitle || "";
        article.abstract = fields.abstract || fields.annote || "";
        article.journal = fields.journal || fields.booktitle || "";
        article.year = fields.year ? parseInt(fields.year) : null;
        article.volume = fields.volume || "";
        article.issue = fields.number || "";
        article.pages = fields.pages || "";
        article.doi = fields.doi || "";
        article.url = fields.url || "";
        
        // Parse authors
        if (fields.author) {
          article.authors = parseBibTeXAuthors(fields.author);
        }
        
        // Parse keywords
        if (fields.keywords) {
          article.topics = fields.keywords.split(/[,;]/).map(k => k.trim()).filter(k => k);
        }
        
        // Set publication date
        if (article.year) {
          article.date = new Date(article.year, 0, 1);
        }
        
        // Format journal info
        article.journal = formatJournalInfo(article);
        
        // Only add if we have meaningful data
        if (article.title || article.authors.length > 0 || article.doi) {
          articles.push(article);
        }
      }
    }
    
    return articles;
  } catch (error) {
    console.error('BibTeX parsing error:', error);
    return [];
  }
}

function parseBibTeXFields(fieldsString) {
  const fields = {};
  const fieldRegex = /(\w+)\s*=\s*({[^}]*}|"[^"]*"|[^,\n]+)/g;
  let match;

  while ((match = fieldRegex.exec(fieldsString)) !== null) {
    const key = match[1].toLowerCase();
    let value = match[2].trim();
    
    // Remove braces and quotes
    if ((value.startsWith('{') && value.endsWith('}')) || 
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.substring(1, value.length - 1);
    }
    
    // Remove any remaining braces
    value = value.replace(/[{}]/g, '');
    
    fields[key] = value;
  }

  return fields;
}

// Helper function to parse BibTeX authors
function parseBibTeXAuthors(authorString) {
  try {
    // Split by "and" but handle cases where "and" might be part of a name
    const authors = [];
    const andSplit = authorString.split(/\s+and\s+/);
    
    for (let author of andSplit) {
      author = author.trim();
      if (!author) continue;
      
      // Handle "Last, First" format
      if (author.includes(',')) {
        const parts = author.split(',').map(part => part.trim());
        if (parts.length > 1) {
          // "Last, First" -> "First Last"
          authors.push(`${parts[1]} ${parts[0]}`);
        } else {
          authors.push(parts[0]);
        }
      } else {
        // Assume "First Last" format
        authors.push(author);
      }
    }
    
    return authors.filter(author => author); // Remove empty strings
  } catch (error) {
    console.error('Error parsing BibTeX authors:', error);
    return [authorString]; // Fallback to original string
  }
}
function formatJournalInfo(article) {
  let journalInfo = article.journal;
  
  if (article.volume) {
    journalInfo += ` - Volume ${article.volume}`;
  }
  
  if (article.issue) {
    journalInfo += `, Issue ${article.issue}`;
  }
  
  if (article.pages) {
    journalInfo += `, pp. ${article.pages}`;
  }
  
  if (article.date) {
    const year = article.date.getFullYear();
    const month = article.date.toLocaleDateString('en-US', { month: 'short' });
    const day = article.date.getDate();
    journalInfo += ` - published ${year}-${String(article.date.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  } else if (article.year) {
    journalInfo += ` - published ${article.year}`;
  }
  
  return journalInfo;
}
function createEmptyArticle() {
  return {
    title: "",
    abstract: "",
    authors: [],
    year: null,
    date: null,
    journal: "",
    volume: "",
    issue: "",
    pages: "",
    doi: "",
    url: "",
    publicationTypes: [],
    topics: [],
    pmid: ""
  };
}
function parseBibliography(content, fileType) {
  if (fileType === "nbib") {
    return parseNBIB(content);
  } else if (fileType === "ris") {
    return parseRIS(content);
  } else {
    throw new Error("Unsupported file type: " + fileType);
  }
}

// Signup route
app.post("/register", async (req, res) => {
  const { firstName, lastName, email, password } = req.body;

  try {
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
    const user = await prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        password: hashedPassword,
      },
    });

    // Generate JWT token
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "24h" });

    res.json({ message: "User created successfully", token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Something went wrong" });
  }
});
app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;

  console.log('🔐 Login attempt for:', email);

  // Input validation
  if (!email || !password) {
    console.log('❌ Missing email or password');
    return res.status(400).json({ 
      message: "Email and password are required" 
    });
  }

  // Basic email validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    console.log('❌ Invalid email format:', email);
    return res.status(400).json({ 
      message: "Please provide a valid email address" 
    });
  }

  try {
    // Find user by email (case insensitive)
    const user = await prisma.user.findUnique({ 
      where: { 
        email: email.toLowerCase().trim() 
      } 
    });
    
    console.log('👤 User found:', user ? 'Yes' : 'No');
    
    if (!user) {
      console.log('❌ User not found in database');
      return res.status(401).json({ 
        message: "Invalid email or password" 
      });
    }

    // Check password
    console.log('🔑 Checking password...');
    const isValidPassword = await bcrypt.compare(password, user.password);
    console.log('Password valid:', isValidPassword);

    if (!isValidPassword) {
      console.log('❌ Invalid password');
      return res.status(401).json({ 
        message: "Invalid email or password" 
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName
      }, 
      process.env.JWT_SECRET || '4W30nq2YZjyAePBTrhXbbUmmv+cDdx9Hk2bwgdMgmWM=', 
      { expiresIn: process.env.JWT_EXPIRES_IN || "24h" }
    );

    console.log('✅ Login successful for:', email);

    res.json({ 
      message: "Login successful", 
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        createdAt: user.createdAt
      }
    });
    
  } catch (error) {
    console.error("❌ Login error:", error);
    res.status(500).json({ 
      message: "Internal server error. Please try again later." 
    });
  }
});
app.get("/api/auth/verify", async (req, res) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '4W30nq2YZjyAePBTrhXbbUmmv+cDdx9Hk2bwgdMgmWM=');
    res.json({ valid: true, user: decoded });
  } catch (error) {
    res.status(401).json({ message: "Invalid token" });
  }
});
// Get current user profile
app.get('/api/user', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Combine first and last name for display
    const userData = {
      ...user,
      name: `${user.firstName} ${user.lastName}`
    };

    res.json(userData);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's projects
app.get('/api/projects', authenticateToken, async (req, res) => {
  try {
    const { status, search } = req.query;
    
    const whereClause = {
      OR: [
        { ownerId: req.user.id }, // Projects user owns
        { members: { some: { userId: req.user.id } } } // Projects user is a member of
      ],
      ...(status && status !== 'all' && { status }),
      ...(search && {
        title: {
          contains: search,
          mode: 'insensitive'
        }
      })
    };

    const projects = await prisma.project.findMany({
      where: whereClause,
      include: {
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        articles: {
          select: {
            id: true
          }
        },
        members: {
          where: {
            userId: req.user.id
          },
          select: {
            role: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Transform the data to match frontend expectations
    const transformedProjects = projects.map(project => {
      const isOwner = project.ownerId === req.user.id;
      const memberRole = project.members[0]?.role;
      
      return {
        id: project.id,
        title: project.title,
        type: project.type,
        domain: project.domain,
        description: project.description,
        status: project.status,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        owner: `${project.owner.firstName} ${project.owner.lastName}`,
        ownerId: project.ownerId,
        
        articleCount: project.articles.length,
        isOwner: isOwner,
        userRole: isOwner ? 'owner' : memberRole
      };
    });

    res.json(transformedProjects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Create new project
app.post('/api/projects', authenticateToken, async (req, res) => {
  try {
    const { title, type, domain, description } = req.body;

    // Validation
    if (!title || !type || !domain) {
      return res.status(400).json({ 
        error: 'Title, type, and domain are required' 
      });
    }

    // Check if title is unique for this user
    const existingProject = await prisma.project.findFirst({
      where: {
        title,
        ownerId: req.user.id
      }
    });

    if (existingProject) {
      return res.status(400).json({ 
        error: 'Project title must be unique' 
      });
    }

    // Create new project
    const newProject = await prisma.project.create({
      data: {
        title,
        type,
        domain,
        description: description || null,
        ownerId: req.user.id,
        blindMode: true,
      },
      include: {
        owner: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        },
        articles: true
      }
    });

    // Transform response
    const transformedProject = {
      id: newProject.id,
      title: newProject.title,
      type: newProject.type,
      domain: newProject.domain,
      description: newProject.description,
      status: newProject.status,
      createdAt: newProject.createdAt,
      updatedAt: newProject.updatedAt,
      owner: `${newProject.owner.firstName} ${newProject.owner.lastName}`,
      articleCount: newProject.articles.length
    };

    res.status(201).json(transformedProject);
  } catch (error) {
    console.error('Error creating project:', error);
    
    if (error.code === 'P2002') {
      return res.status(400).json({ 
        error: 'Project title must be unique' 
      });
    }
    
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get specific project
// Get specific project - UPDATED VERSION
app.get('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const project = await prisma.project.findFirst({
      where: {
        id,
        OR: [
          { ownerId: req.user.id }, // owner
          { members: { some: { userId: req.user.id } } } // invited member
        ]
      },
      include: {
        owner: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        },
        members: {
          select: {
            id: true,
            role: true,
            user: {
              select: { id: true, email: true, firstName: true, lastName: true }
            }
          }
        },
        // ✅ ADD THIS: Include invitations
        invitations: {
          select: {
            id: true,
            email: true,
            role: true,
            accepted: true,
            createdAt: true
          },
          orderBy: {
            createdAt: 'desc'
          }
        },
        articles: {
          orderBy: {
            createdAt: 'desc'
          }
        }
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found or access denied' });
    }

    res.json(project);
  } catch (error) {
    console.error('Error fetching project:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update project
app.put('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, type, domain, description, status } = req.body;

    // Check if project exists and belongs to user
    const existingProject = await prisma.project.findFirst({
      where: {
        id,
        ownerId: req.user.id
      }
    });

    if (!existingProject) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Update project
    const updatedProject = await prisma.project.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(type && { type }),
        ...(domain && { domain }),
        ...(description !== undefined && { description }),
        ...(status && { status })
      },
      include: {
        owner: {
          select: {
            firstName: true,
            lastName: true,
            email: true
          }
        },
        articles: true
      }
    });

    // Transform response
    const transformedProject = {
      id: updatedProject.id,
      title: updatedProject.title,
      type: updatedProject.type,
      domain: updatedProject.domain,
      description: updatedProject.description,
      status: updatedProject.status,
      createdAt: updatedProject.createdAt,
      updatedAt: updatedProject.updatedAt,
      owner: `${updatedProject.owner.firstName} ${updatedProject.owner.lastName}`,
      articleCount: updatedProject.articles.length
    };

    res.json(transformedProject);
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send Invite
app.post("/api/invite", authenticateToken, async (req, res) => {
  const { emails, role, message, projectId } = req.body;
  const emailList = emails.split(",").map(e => e.trim());

  for (const email of emailList) {
    const token = crypto.randomBytes(20).toString("hex");

    await prisma.invitation.create({
      data: { 
        email,
        role,
        message,
        token,
        project: { connect: { id: projectId } },
        invitedBy: { connect: { id: req.user.id } },
      },
    });

    const inviteLink = `http://localhost:5000/api/invite/accept?token=${token}`;

    await transporter.sendMail({
      from: "youssefelkoumi512@gmail.com",
      to: email,
      subject: "You're Invited to Join a Project",
      text: `
Hello,

${req.user.email} has invited you to collaborate on their project.

Role: ${role}
Message: ${message || "No message provided."}

Click here to accept: ${inviteLink}

Thanks,
Kior Team
      `,
    });
  }

  res.json({ message: "Invitations sent successfully" });
});

// Accept invitation
// Enhanced invitation acceptance with better debugging
app.get('/api/invite/accept', async (req, res) => {
  const { token } = req.query;
  console.log('🔑 Invitation token received:', token);

  try {
    if (!token) {
      console.log('❌ No token provided');
      return res.status(400).json({ error: 'Missing token' });
    }

    const invitation = await prisma.invitation.findUnique({
      where: { token },
      include: { 
        project: true, 
        invitedBy: true 
      }
    });

    if (!invitation) {
      console.log('❌ Invalid invitation token');
      return res.status(400).json({ error: 'Invalid or expired invitation' });
    }

    console.log('📧 Invitation found for email:', invitation.email);
    console.log('🏗️ Project ID:', invitation.projectId);

    const user = await prisma.user.findUnique({
      where: { email: invitation.email }
    });

    if (user) {
      console.log('✅ User exists:', user.email);
      
      // Mark invitation as accepted
      await prisma.invitation.update({
        where: { token },
        data: { accepted: true }
      });

      // Check if user is already a member
      const existingMember = await prisma.projectMember.findFirst({
        where: { 
          userId: user.id, 
          projectId: invitation.projectId 
        }
      });

      if (!existingMember) {
        console.log('👥 Adding user to project members');
        await prisma.projectMember.create({
          data: {
            role: invitation.role,
            user: { connect: { id: user.id } },
            project: { connect: { id: invitation.projectId } }
          }
        });
        console.log('✅ User added to project');
      } else {
        console.log('ℹ️ User already a project member');
      }

      // Generate JWT
      const jwtToken = jwt.sign(
        { id: user.id, email: user.email },
        JWT_SECRET,
        { expiresIn: "24h" }
      );

      console.log('🔐 JWT generated, redirecting to project');
      return res.redirect(
        `http://localhost:5173/projects/${invitation.projectId}?token=${jwtToken}`
      );

    } else {
      console.log('❌ User does not exist, redirecting to signup');
      return res.redirect(
        `http://localhost:5173/register?` + 
        `email=${encodeURIComponent(invitation.email)}&` +
        `projectId=${invitation.projectId}&` +
        `inviteToken=${token}&` +
        `role=${invitation.role}`
      );
    }

  } catch (error) {
    console.error("❌ Error accepting invite:", error);
    return res.redirect(
      `http://localhost:5173/error?message=${encodeURIComponent('Failed to process invitation')}`
    );
  }
});
app.post('/api/invite/complete', authenticateToken, async (req, res) => {
  try {
    const { inviteToken } = req.body;

    if (!inviteToken) {
      return res.status(400).json({ error: 'Invite token required' });
    }

    const invitation = await prisma.invitation.findUnique({
      where: { token: inviteToken }
    });

    if (!invitation) {
      return res.status(400).json({ error: 'Invalid invitation token' });
    }

    if (invitation.email !== req.user.email) {
      return res.status(403).json({ error: 'Invitation email does not match user email' });
    }

    // Mark invitation as accepted
    await prisma.invitation.update({
      where: { token: inviteToken },
      data: { accepted: true }
    });

    // Add user as project member if not already
    const existingMember = await prisma.projectMember.findFirst({
      where: { userId: req.user.id, projectId: invitation.projectId }
    });

    if (!existingMember) {
      await prisma.projectMember.create({
        data: {
          role: invitation.role,
          user: { connect: { id: req.user.id } },
          project: { connect: { id: invitation.projectId } }
        }
      });
    }

    res.json({ 
      message: 'Invitation completed successfully',
      projectId: invitation.projectId 
    });

  } catch (error) {
    console.error('Error completing invitation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Get collaborative screening data for a project
app.get('/api/projects/:projectId/screening-data', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    console.log(`Loading screening data for project ${projectId}, user ${userId}`);

    // First check if user has access (consistent with your check-access endpoint)
    const hasAccess = await checkProjectAccess(projectId, userId);
    if (!hasAccess) {
      console.log(`Access denied for user ${userId} to project ${projectId}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Load the project with all screening data
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: {
        screeningDecisions: {
          include: { 
            user: { 
              select: { id: true, firstName: true, lastName: true } 
            }
          }
        },
        screeningNotes: {
          include: { 
            user: { 
              select: { id: true, firstName: true, lastName: true } 
            }
          }
        }
      }
    });

    if (!project) {
      console.log(`Project ${projectId} not found`);
      return res.status(404).json({ error: 'Project not found' });
    }

    console.log(`Found ${project.screeningDecisions?.length || 0} decisions and ${project.screeningNotes?.length || 0} notes`);

    // Return the data in the format expected by your frontend
    res.json({
      decisions: project.screeningDecisions || [],
      notes: project.screeningNotes || []
    });

  } catch (error) {
    console.error('Error loading screening data:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ 
      error: 'Failed to load screening data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Helper function to check project access (extract common logic)
async function checkProjectAccess(projectId, userId) {
  try {
    // Check if user is project owner
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        ownerId: userId
      }
    });

    if (project) {
      return true;
    }

    // Check if user is project member
    const projectMember = await prisma.projectMember.findFirst({
      where: {
        projectId: projectId,
        userId: userId
      }
    });

    return !!projectMember;
  } catch (error) {
    console.error('Error checking project access:', error);
    return false;
  }
}

// Save screening decision
// Updated screening-decisions endpoint with correct unique constraint
app.post('/api/projects/:projectId/screening-decisions', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { articleId, status, notes } = req.body;

    console.log(`Saving screening decision: project=${projectId}, user=${userId}, article=${articleId}, status=${status}`);

    // Validate input
    if (!articleId || !status) {
      return res.status(400).json({ error: 'articleId and status are required' });
    }

    if (!['include', 'exclude', 'maybe', 'unscreened'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    // Check access using the helper function from the artifact
    const hasAccess = await checkProjectAccess(projectId, userId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Start a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Upsert decision with correct constraint name
      const decision = await tx.screeningDecision.upsert({
        where: {
          projectId_articleId_userId: {  // This matches your schema
            projectId: projectId,
            articleId: articleId,
            userId: userId
          }
        },
        update: {
          status: status,
          updatedAt: new Date()
        },
        create: {
          userId: userId,
          articleId: articleId,
          status: status,
          projectId: projectId
        },
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true }
          }
        }
      });

      // Handle notes with correct constraint name
      let noteResult = null;
      if (notes !== undefined && notes !== null) {
        noteResult = await tx.screeningNote.upsert({
          where: {
            projectId_articleId_userId: {  // This matches your schema
              projectId: projectId,
              articleId: articleId,
              userId: userId
            }
          },
          update: {
            notes: notes,
            updatedAt: new Date()
          },
          create: {
            userId: userId,
            articleId: articleId,
            notes: notes,
            projectId: projectId
          },
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true }
            }
          }
        });
      }

      return { decision, note: noteResult };
    });

    console.log(`Successfully saved screening decision`);

    res.json({ 
      success: true, 
      decision: result.decision,
      note: result.note 
    });

  } catch (error) {
    console.error('Error saving screening decision:', error);
    res.status(500).json({ error: 'Failed to save decision' });
  }
});
// Add this to your backend routes
app.get('/api/projects/:projectId/check-access', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;

    // Check if user is a project member
    const projectMember = await prisma.projectMember.findFirst({
      where: {
        projectId: projectId,
        userId: req.user.id
      },
      include: {
        project: true
      }
    });

    if (projectMember) {
      return res.json({ 
        hasAccess: true,
        role: projectMember.role,
        project: projectMember.project
      });
    }

    // Check if user is the project owner
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        ownerId: req.user.id
      }
    });

    if (project) {
      return res.json({ 
        hasAccess: true,
        role: 'owner',
        project: project
      });
    }

    return res.status(403).json({ error: 'Access denied' });

  } catch (error) {
    console.error('Error checking project access:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET /api/projects/:projectId/team-stats (UPDATED)
app.get('/api/projects/:projectId/team-stats', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { range = 'week' } = req.query;
    const userId = req.user.id;

    console.log(`Fetching team stats for project ${projectId}, user ${userId}, range: ${range}`);

    // Validate projectId
    if (!projectId || projectId === 'undefined') {
      console.error('Invalid project ID:', projectId);
      return res.status(400).json({ error: 'Invalid project ID' });
    }

    // Check if user has access to this project
    const hasAccess = await checkProjectAccess(projectId, userId);
    if (!hasAccess) {
      console.log(`Access denied for user ${userId} to project ${projectId}`);
      return res.status(403).json({ error: 'Access denied' });
    }

    // Calculate date range
    let startDate;
    const now = new Date();
    
    switch (range) {
      case 'week':
        startDate = new Date(now);
        startDate.setDate(now.getDate() - 7);
        break;
      case 'month':
        startDate = new Date(now);
        startDate.setMonth(now.getMonth() - 1);
        break;
      case 'all':
      default:
        startDate = new Date(0);
    }

    // Get project with members
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: userId },
          { members: { some: { userId: userId } } }
        ]
      },
      include: {
        owner: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true
              }
            }
          }
        }
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Combine owner and members into one array
    const allMembers = [
      { user: project.owner, role: 'Owner' },
      ...project.members.map(member => ({
        user: member.user,
        role: member.role
      }))
    ];

    const teamStats = await Promise.all(
      allMembers.map(async (member) => {
        const memberUserId = member.user.id;

        try {
          // Get screening sessions
          const screeningSessions = await prisma.screeningSession.findMany({
            where: {
              projectId: projectId,
              userId: memberUserId,
              startTime: { gte: startDate }
            }
          });

          // Get screening decisions for articles screened count
          const screeningDecisions = await prisma.screeningDecision.findMany({
            where: {
              projectId: projectId,
              userId: memberUserId,
              createdAt: { gte: startDate }
            },
            orderBy: {
              createdAt: 'asc'
            }
          });

          // Get screening notes
          const screeningNotes = await prisma.screeningNote.findMany({
            where: {
              projectId: projectId,
              userId: memberUserId,
              createdAt: { gte: startDate }
            }
          });

          // Calculate time spent screening from actual sessions
          let totalMinutes = 0;
          let completedSessions = 0;
          let activeSessions = 0;
          
          screeningSessions.forEach(session => {
            if (session.endTime && session.startTime) {
              // Completed session - use stored duration or calculate it
              const duration = session.duration || 
                Math.floor((new Date(session.endTime) - new Date(session.startTime)) / (1000 * 60));
              totalMinutes += duration;
              completedSessions++;
            } else {
              // Active session - count it but don't add to time yet
              activeSessions++;
            }
          });

          const sessionCount = completedSessions;
          const articlesScreened = screeningDecisions.length;

          // Get last activity
          let lastActivity = null;
          const allActivities = [
            ...screeningSessions.map(s => s.startTime),
            ...screeningDecisions.map(d => d.createdAt),
            ...screeningNotes.map(n => n.createdAt)
          ].filter(Boolean);
          
          if (allActivities.length > 0) {
            lastActivity = new Date(Math.max(...allActivities.map(d => new Date(d))));
          }

          // Calculate decisions by status
          const decisionsByStatus = {
            include: screeningDecisions.filter(d => d.status === 'include').length,
            exclude: screeningDecisions.filter(d => d.status === 'exclude').length,
            maybe: screeningDecisions.filter(d => d.status === 'maybe').length,
            conflict: screeningDecisions.filter(d => d.status === 'conflict').length
          };

          return {
            userId: memberUserId,
            firstName: member.user.firstName,
            lastName: member.user.lastName,
            email: member.user.email,
            role: member.role,
            totalMinutes: Math.round(totalMinutes),
            sessionCount: sessionCount,
            activeSessions: activeSessions,
            articlesScreened: articlesScreened,
            lastActivity: lastActivity,
            avgTimePerArticle: totalMinutes > 0 && articlesScreened > 0 ? 
              Math.round((totalMinutes / articlesScreened) * 10) / 10 : 0,
            decisionsByStatus: decisionsByStatus,
            notesCount: screeningNotes.length
          };
        } catch (memberError) {
          console.error(`Error processing member ${memberUserId}:`, memberError);
          return {
            userId: memberUserId,
            firstName: member.user.firstName,
            lastName: member.user.lastName,
            email: member.user.email,
            role: member.role,
            totalMinutes: 0,
            sessionCount: 0,
            activeSessions: 0,
            articlesScreened: 0,
            lastActivity: null,
            avgTimePerArticle: 0,
            decisionsByStatus: { include: 0, exclude: 0, maybe: 0, conflict: 0 },
            notesCount: 0
          };
        }
      })
    );

    // Sort by articles screened (descending)
    teamStats.sort((a, b) => b.articlesScreened - a.articlesScreened);

    res.json(teamStats);

  } catch (error) {
    console.error('Error fetching team stats:', error);
    res.status(500).json({ 
      error: 'Failed to fetch team statistics',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Start a screening session (FIXED)
app.post('/api/projects/:projectId/screening-sessions/start', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;

    // Check access
    const hasAccess = await checkProjectAccess(projectId, userId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Find any existing active sessions for this user in this project
    const activeSessions = await prisma.screeningSession.findMany({
      where: {
        projectId,
        userId,
        endTime: null
      }
    });

    // End any existing active sessions properly
    const now = new Date();
    for (const activeSession of activeSessions) {
      const duration = Math.floor((now - new Date(activeSession.startTime)) / (1000 * 60));
      await prisma.screeningSession.update({
        where: { id: activeSession.id },
        data: {
          endTime: now,
          duration: Math.max(0, duration) // Ensure non-negative duration
        }
      });
    }

    // Start new session
    const session = await prisma.screeningSession.create({
      data: {
        projectId,
        userId,
        startTime: new Date()
      }
    });

    res.json({ sessionId: session.id, success: true });
  } catch (error) {
    console.error('Error starting screening session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// End a screening session (FIXED)
app.post('/api/projects/:projectId/screening-sessions/:sessionId/end', authenticateToken, async (req, res) => {
  try {
    const { projectId, sessionId } = req.params;
    const userId = req.user.id;

    const session = await prisma.screeningSession.findFirst({
      where: {
        id: sessionId,
        projectId,
        userId
      }
    });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // If session already ended, return the existing duration
    if (session.endTime) {
      return res.json({ 
        success: true, 
        duration: session.duration,
        alreadyEnded: true 
      });
    }

    const endTime = new Date();
    const duration = Math.floor((endTime - new Date(session.startTime)) / (1000 * 60));

    const updatedSession = await prisma.screeningSession.update({
      where: { id: sessionId },
      data: {
        endTime,
        duration: Math.max(0, duration) // Ensure non-negative duration
      }
    });

    res.json({ success: true, duration: updatedSession.duration });
  } catch (error) {
    console.error('Error ending screening session:', error);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// Debug endpoint (ENHANCED)
app.get('/api/debug/sessions/:projectId', authenticateToken, async (req, res) => {
  const { projectId } = req.params;
  const { userId } = req.query;
  
  const whereClause = { projectId };
  if (userId) whereClause.userId = userId;
  
  const sessions = await prisma.screeningSession.findMany({
    where: whereClause,
    include: {
      user: {
        select: { firstName: true, lastName: true, email: true }
      }
    },
    orderBy: { startTime: 'desc' }
  });
  
  const totalDuration = sessions.reduce((sum, s) => {
    if (s.duration) return sum + s.duration;
    if (s.endTime) {
      return sum + Math.floor((new Date(s.endTime) - new Date(s.startTime)) / (1000 * 60));
    }
    return sum;
  }, 0);
  
  res.json({
    totalSessions: sessions.length,
    completedSessions: sessions.filter(s => s.endTime).length,
    activeSessions: sessions.filter(s => !s.endTime).length,
    totalDurationMinutes: totalDuration,
    sessions: sessions.map(s => ({
      id: s.id,
      user: `${s.user.firstName} ${s.user.lastName}`,
      userId: s.userId,
      startTime: s.startTime,
      endTime: s.endTime,
      storedDuration: s.duration,
      calculatedDuration: s.endTime ? 
        Math.floor((new Date(s.endTime) - new Date(s.startTime)) / (1000 * 60)) : null,
      status: s.endTime ? 'completed' : 'active'
    }))
  });
});

// Track page views (FIXED)
app.post('/api/projects/:projectId/page-views', authenticateToken, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user.id;
    const { pagePath, startTime, endTime } = req.body;

    const hasAccess = await checkProjectAccess(projectId, userId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const start = new Date(startTime);
    const end = endTime ? new Date(endTime) : null;
    const duration = end ? Math.max(0, Math.floor((end - start) / (1000 * 60))) : null;

    const pageView = await prisma.pageView.create({
      data: {
        projectId,
        userId,
        pagePath,
        startTime: start,
        endTime: end,
        duration
      }
    });

    res.json({ success: true, pageViewId: pageView.id });
  } catch (error) {
    console.error('Error tracking page view:', error);
    res.status(500).json({ error: 'Failed to track page view' });
  }
});
app.post("/api/projects/:id/upload", upload.array("files"), async (req, res) => {
  try {
    const { id: projectId } = req.params;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    let allParsedArticles = [];
    let errors = [];

    // Step 1: Parse all files and collect articles
    console.log(`Processing ${files.length} files for project ${projectId}`);
    
    for (const file of files) {
      try {
        console.log(`Processing file: ${file.originalname}, size: ${file.size} bytes`);
        const filePath = path.resolve(file.path);
        let parsedArticles = [];

        // Handle ZIP files
        if (file.originalname.toLowerCase().endsWith(".zip")) {
          parsedArticles = await parseZIPFile(filePath);
        } else {
          // Handle individual files
          const content = fs.readFileSync(filePath, "utf8");
          
          if (file.originalname.toLowerCase().endsWith(".nbib")) {
            parsedArticles = parseNBIB(content);
          } else if (file.originalname.toLowerCase().endsWith(".ris")) {
            parsedArticles = parseRIS(content);
          } else if (file.originalname.toLowerCase().endsWith(".bib")) {
            parsedArticles = parseBibTeX(content);
          } else if (file.originalname.toLowerCase().endsWith(".csv")) {
            parsedArticles = parseCSV(content);
          } else {
            errors.push({ fileName: file.originalname, error: "Unsupported file format" });
            continue;
          }
        }

        if (!parsedArticles || parsedArticles.length === 0) {
          errors.push({ fileName: file.originalname, error: "No articles found" });
          continue;
        }

        console.log(`Parsed ${parsedArticles.length} articles from ${file.originalname}`);

        // Add source file info and sanitize data
        parsedArticles.forEach(article => {
          article.sourceFile = file.originalname;

          // Truncate title if too long (VARCHAR 191 is default for Prisma String type)
          if (article.title && article.title.length > 191) {
            article.title = article.title.substring(0, 188) + "...";
          }

          // Ensure URL is set properly
          if (!article.url || article.url.includes("uploads\\")) {
            article.url = article.pmid
              ? `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`
              : article.doi
              ? `https://doi.org/${article.doi}`
              : null;
          }
        });

        allParsedArticles.push(...parsedArticles);
      } catch (fileError) {
        console.error(`Error processing ${file.originalname}:`, fileError);
        errors.push({
          fileName: file.originalname,
          error: `File processing failed: ${fileError.message}`
        });
      }
    }

    console.log(`Total articles parsed: ${allParsedArticles.length}`);

    // Step 2: Save articles in batches to avoid connection pool exhaustion
    const BATCH_SIZE = 25; // Adjust based on your connection pool size
    const batches = [];
    
    for (let i = 0; i < allParsedArticles.length; i += BATCH_SIZE) {
      batches.push(allParsedArticles.slice(i, i + BATCH_SIZE));
    }

    const savedArticles = [];
    
    for (let i = 0; i < batches.length; i++) {
      console.log(`Saving batch ${i + 1} of ${batches.length}`);
      const batch = batches[i];
      
      const batchResults = await Promise.all(
        batch.map(async (article) => {
          try {
            // Additional validation - VARCHAR(191) is default for String in Prisma
            const title = (article.title || "Untitled").substring(0, 191);
            const abstract = article.abstract || "No abstract available.";

            return await prisma.article.create({
              data: {
                title,
                abstract,
                journal: article.journal ? article.journal.substring(0, 191) : null,
                year: article.year ? parseInt(article.year, 10) : null,
                date: article.date || null,
                doi: article.doi ? article.doi.substring(0, 191) : null,
                url: article.url || null,
                pmid: article.pmid ? article.pmid.substring(0, 191) : null,
                projectId,

                authors: {
                  create: (article.authors || []).map((name) => ({ 
                    name: name.substring(0, 191)
                  })),
                },

                publicationTypes: {
                  create: (article.publicationTypes || []).map((value) => ({ 
                    value: value.substring(0, 191)
                  })),
                },

                topics: {
                  create: (article.topics || []).map((value) => ({ 
                    value: value.substring(0, 191)
                  })),
                },
              },
              include: { 
                authors: true, 
                publicationTypes: true, 
                topics: true 
              },
            });
          } catch (dbError) {
            console.error(`Database error for article "${article.title}":`, dbError);
            errors.push({
              fileName: article.sourceFile,
              articleTitle: article.title,
              error: `Database save failed: ${dbError.message}`
            });
            return null;
          }
        })
      );

      savedArticles.push(...batchResults.filter(article => article !== null));
      
      // Small delay between batches to prevent overwhelming the database
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    console.log(`Successfully saved ${savedArticles.length} articles`);

    // Step 3: Clean up uploaded files
    try {
      for (const file of files) {
        fs.unlinkSync(file.path);
      }
    } catch (cleanupError) {
      console.warn('File cleanup warning:', cleanupError.message);
    }

    res.json({
      success: true,
      totalParsed: allParsedArticles.length,
      importedReferences: savedArticles.length,
      articles: savedArticles,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err) {
    console.error('Upload endpoint error:', err);
    res.status(500).json({ 
      error: "File upload and analysis failed", 
      details: err.message 
    });
  }
});
// Delete project
app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if project exists and belongs to user
    const existingProject = await prisma.project.findFirst({
      where: {
        id,
        ownerId: req.user.id
      }
    });

    if (!existingProject) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Delete project (articles will be deleted due to cascade)
    await prisma.project.delete({
      where: { id }
    });

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get("/api/projects/:projectId/articles", async (req, res) => {
  try {
    const { projectId } = req.params;

const articles = await prisma.article.findMany({
  where: { projectId },
  include: {
    authors: true,
    publicationTypes: true,
    topics: true,
  },
});


    res.json(articles);
  } catch (error) {
    console.error("Error fetching articles:", error);
    res.status(500).json({ error: "Failed to fetch articles" });
  }
});
app.get("/api/projects/:id/analysis", async (req, res) => {
  try {
    const { id } = req.params;

    const project = await prisma.project.findUnique({
      where: { id },
      include: { articles: true },
    });

    if (!project) {
      return res.status(404).json({ message: "Project not found" });
    }

    // 🔹 normalize helper
    function normalizeTitle(title = "") {
      return title.trim().toLowerCase().replace(/\s+/g, " ");
    }

    const seen = new Map();
    const duplicates = [];

    for (let art of project.articles || []) {
      const titleKey = normalizeTitle(art.title);
      const yearKey = art.year ? art.year.toString() : "";
      const key = `${titleKey}-${yearKey}`;

      if (seen.has(key)) {
        duplicates.push(art);
      } else {
        seen.set(key, art);
      }
    }

    res.json({
      totalArticles: project.articles.length,
      totalDuplicates: duplicates.length,
      unresolved: duplicates.length,
      resolved: 0,
      notDuplicate: 0,
      deleted: 0,
      duplicates,
      articles: project.articles,
    });
  } catch (err) {
    console.error("Error fetching analysis:", err);
    res.status(500).json({ message: "Server error", details: err.message });
  }
});

// Update blind mode setting for a project
app.put('/api/projects/:id/blind-mode', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { blindMode } = req.body;

    // Check if user is project owner
    const project = await prisma.project.findFirst({
      where: {
        id,
        ownerId: req.user.id
      }
    });

    if (!project) {
      return res.status(403).json({ error: 'Only project owner can change blind mode' });
    }

    // Update blind mode setting
    const updatedProject = await prisma.project.update({
      where: { id },
      data: { blindMode }
    });

    // Broadcast to all connected users via WebSocket
    broadcastToProject(id, {
      type: 'BLIND_MODE_CHANGED',
      projectId: id,
      blindMode: blindMode
    });

    res.json({ 
      success: true, 
      blindMode: updatedProject.blindMode 
    });

  } catch (error) {
    console.error('Error updating blind mode:', error);
    res.status(500).json({ error: 'Failed to update blind mode' });
  }
});

// GET /api/projects/:projectId/fulltext-articles
app.get('/api/projects/:projectId/fulltext-articles', async (req, res) => {
  try {
    // Get articles that have screening decisions of 'include' or 'maybe'
    const articles = await prisma.article.findMany({
      where: {
        projectId: req.params.projectId,
        screeningDecisions: {
          some: {
            status: {
              in: ['include', 'maybe']
            }
          }
        }
      },
      include: {
        authors: true,
        screeningDecisions: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true
              }
            }
          }
        },
        fullTextUploadedBy: {
          select: {
            firstName: true,
            lastName: true
          }
        }
      }
    });

    // Transform the data to match what the frontend expects
    const transformedArticles = articles.map(article => {
      // Get the latest screening decision
      const latestDecision = article.screeningDecisions
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      
      return {
        id: article.id,
        title: article.title,
        abstract: article.abstract,
        journal: article.journal,
        date: article.date,
        authors: article.authors,
        screeningDecision: latestDecision?.status || 'unscreened',
        fullTextFile: article.fullTextFileName ? {
          filename: article.fullTextFileName,
          originalName: article.fullTextFileName,
          path: article.fullTextFilePath,
          uploadedBy: article.fullTextUploadedBy,
          uploadedAt: article.fullTextUploadedAt
        } : null
      };
    });

    res.json({ articles: transformedArticles });
  } catch (error) {
    console.error('Error fetching full-text articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

app.post('/api/projects/:projectId/upload-fulltext', 
  authenticateToken, 
  uploadPDF.single('fullText'),
  async (req, res) => {
    try {
      const { projectId } = req.params;
      const { articleId } = req.body;
      const userId = req.user.id;

      // Validate inputs
      if (!articleId) {
        return res.status(400).json({ error: 'Article ID is required' });
      }

      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // Check project access - include project owners
      const project = await prisma.project.findFirst({
        where: { id: projectId },
        include: {
          members: {
            where: { userId: userId }
          }
        }
      });

      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }

      // Check if user is either a member OR the owner
      const isMember = project.members.length > 0;
      const isOwner = project.ownerId === userId;

      console.log('Access check:', { isMember, isOwner, ownerId: project.ownerId, userId });

      if (!isMember && !isOwner) {
        return res.status(403).json({ 
          error: 'Access denied to project',
          details: 'You are not a member or owner of this project'
        });
      }

      // Update article
      const updatedArticle = await prisma.article.update({
        where: { 
          id: articleId, 
          projectId: projectId 
        },
        data: {
          fullTextFileName: req.file.originalname,
          fullTextFilePath: req.file.path,
          fullTextUploadedById: userId,
          fullTextUploadedAt: new Date()
        },
        include: {
          fullTextUploadedBy: {
            select: { firstName: true, lastName: true }
          }
        }
      });

      res.json({
        message: 'Full-text uploaded successfully',
        article: updatedArticle
      });

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({ 
        error: 'Failed to upload full-text',
        details: error.message 
      });
    }
  }
);
// GET /api/projects/:projectId/download-fulltext/:articleId
// GET /api/projects/:projectId/download-fulltext/:articleId
app.get('/api/projects/:projectId/download-fulltext/:articleId', async (req, res) => {
  try {
    // Get token from either Authorization header or query parameter
    let token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token && req.query.token) {
      token = req.query.token;
    }

    console.log('Token received:', token ? 'Yes' : 'No');

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    // Check if JWT_SECRET is available
    const jwtSecret = process.env.JWT_SECRET;
    console.log('JWT_SECRET available:', !!jwtSecret);
    
    if (!jwtSecret) {
      console.error('JWT_SECRET is not defined in environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Verify the token
    let decoded;
    try {
      decoded = jwt.verify(token, jwtSecret);
      console.log('Token decoded successfully. User ID:', decoded.id);
    } catch (jwtError) {
      console.error('JWT Verification Error:', jwtError.name, jwtError.message);
      
      if (jwtError.name === 'JsonWebTokenError') {
        return res.status(401).json({ 
          error: 'Invalid token',
          details: 'Token signature verification failed'
        });
      }
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({ 
          error: 'Token expired',
          details: 'Please log in again'
        });
      }
      throw jwtError;
    }

    const userId = decoded.id;
    const { projectId, articleId } = req.params;

    console.log('Download request:', { projectId, articleId, userId });

    // Check project access first
    const project = await prisma.project.findFirst({
      where: { id: projectId },
      include: {
        members: {
          where: { userId: userId }
        }
      }
    });

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const isMember = project.members.length > 0;
    const isOwner = project.ownerId === userId;

    if (!isMember && !isOwner) {
      return res.status(403).json({ error: 'Access denied to project' });
    }

    // Get the article
    const article = await prisma.article.findFirst({
      where: {
        id: articleId,
        projectId: projectId
      }
    });

    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }

    if (!article.fullTextFileName || !article.fullTextFilePath) {
      return res.status(404).json({ error: 'Full-text file not found for this article' });
    }

    // Check if file exists
    if (!fs.existsSync(article.fullTextFilePath)) {
      console.error('File not found at path:', article.fullTextFilePath);
      return res.status(404).json({ error: 'File not found on server' });
    }

    console.log('Sending file via res.download:', {
      path: article.fullTextFilePath,
      filename: article.fullTextFileName
    });

    // Use Express's built-in download method
    res.download(article.fullTextFilePath, article.fullTextFileName, (error) => {
      if (error) {
        console.error('Download error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
      } else {
        console.log('File sent successfully');
      }
    });

  } catch (error) {
    console.error('Error in download endpoint:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download failed', details: error.message });
    }
  }
});
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server running locally on http://localhost:${PORT}`);
  });
}

// ✅ Export for Vercel serverless
export default app;
