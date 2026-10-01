#!/usr/bin/env node
 
import express from 'express';
import { createHmac } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import AdmZip from 'adm-zip';
 
const app = express();
const PORT = process.env.PORT || 3000;
 
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
 
if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !ANTHROPIC_API_KEY) {
  console.error('Missing environment variables');
  process.exit(1);
}
 
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
 
app.use(express.json());
 
// Verify Slack signature
function verifySlackSignature(req) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  
  if (!timestamp || !signature) return false;
  
  const time = Math.floor(Date.now() / 1000);
  if (Math.abs(time - parseInt(timestamp)) > 300) return false;
  
  const sigBasestring = `v0:${timestamp}:${JSON.stringify(req.body)}`;
  const mySignature = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(sigBasestring)
    .digest('hex');
  
  return mySignature === signature;
}
 
// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});
 
// Slack events and commands
app.post('/slack/events', async (req, res) => {
  if (!verifySlackSignature(req)) {
    console.error('Invalid signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }
 
  const { type, challenge } = req.body;
 
  // Slack challenge for URL verification
  if (type === 'url_verification') {
    return res.json({ challenge });
  }
 
  // Handle slash commands
  if (req.body.command === '/resource-deliverables') {
    res.json({ response_type: 'in_channel', text: 'Processing resource deliverables...' });
    return;
  }
 
  // Handle message events
  if (type === 'event_callback') {
    const event = req.body.event;
    
    if (event.text && event.text.toLowerCase().includes('resource deliverables') && event.files) {
      res.json({ ok: true });
      
      // Process in background
      handleResourceDeliverables(event.channel, event.ts, event.files[0])
        .catch(err => console.error('Error processing:', err));
      
      return;
    }
  }
 
  res.json({ ok: true });
});
 
async function handleResourceDeliverables(channelId, threadTs, file) {
  try {
    const tempDir = path.join('/tmp', `resource-${Date.now()}`);
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
 
    // Download file
    const downloadPath = path.join(tempDir, file.name);
    await downloadFile(file.url_private, downloadPath, SLACK_BOT_TOKEN);
 
    // Extract ZIP
    if (file.name.endsWith('.zip')) {
      const zip = new AdmZip(downloadPath);
      zip.extractAllTo(extractDir, true);
    } else {
      fs.copyFileSync(downloadPath, path.join(extractDir, file.name));
    }
 
    // Process photos
    const result = await processPhotos(extractDir);
 
    if (result.success) {
      // Upload result to Slack
      await uploadToSlack(channelId, threadTs, result.zipPath);
    }
 
    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  } catch (error) {
    console.error('Resource deliverables error:', error);
  }
}
 
function downloadFile(url, filepath, token) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { Authorization: `Bearer ${token}` },
    };
    const file = fs.createWriteStream(filepath);
    https
      .get(url, options, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
  });
}
 
function imageToBase64(filepath) {
  return fs.readFileSync(filepath).toString('base64');
}
 
function getMediaType(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const types = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return types[ext] || 'image/jpeg';
}
 
async function analyzePhoto(filepath) {
  try {
    const base64 = imageToBase64(filepath);
    const mediaType = getMediaType(filepath);
 
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-1-20250805',
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: `Identify this infrastructure photo. Respond ONLY with JSON: {"subject":"Rack|Cabinet|Patch-Panel|Switch|Switch-Stack|AP|Data-Jack|Faceplate|Fiber|Cable-Tray|Conduit|Demarc|Overview|Misc","detail":"null or: MDF, IDF1, Corridor, etc","variant":"null or: WIDE, CLOSE, REAR"}`,
            },
          ],
        },
      ],
    });
 
    try {
      return JSON.parse(response.content[0].text);
    } catch (e) {
      return { subject: 'Misc', detail: null, variant: null };
    }
  } catch (error) {
    console.error('Vision error:', error);
    return { subject: 'Misc', detail: null, variant: null };
  }
}
 
function buildFilename(subject, detail, variant, number, ext) {
  let name = subject;
  if (detail) name += `-${detail}`;
  if (variant) name += `-${variant}`;
  name += `-${String(number).padStart(2, '0')}`;
  return name + ext;
}
 
async function processPhotos(sourceDir) {
  const imageExtensions = ['.jpg', '.jpeg', '.png'];
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => imageExtensions.includes(path.extname(f).toLowerCase()));
 
  if (files.length === 0) {
    return { success: false, message: 'No images found' };
  }
 
  // Analyze photos
  const analyses = {};
  for (const file of files) {
    const filepath = path.join(sourceDir, file);
    analyses[file] = await analyzePhoto(filepath);
  }
 
  // Build rename mapping
  const nameGroups = {};
  const renames = {};
 
  for (const file of files) {
    const analysis = analyses[file];
    const ext = path.extname(file);
    const key = `${analysis.subject}|${analysis.detail || ''}|${analysis.variant || ''}`;
 
    if (!nameGroups[key]) nameGroups[key] = [];
    nameGroups[key].push(file);
  }
 
  for (const [key, fileGroup] of Object.entries(nameGroups)) {
    const [subject, detail, variant] = key.split('|');
    for (let i = 0; i < fileGroup.length; i++) {
      const file = fileGroup[i];
      const newName = buildFilename(
        subject,
        detail || null,
        variant || null,
        i + 1,
        path.extname(file)
      );
      renames[file] = newName;
    }
  }
 
  // Rename files
  for (const [old, newName] of Object.entries(renames)) {
    const oldPath = path.join(sourceDir, old);
    const newPath = path.join(sourceDir, newName);
    fs.renameSync(oldPath, newPath);
  }
 
  // Compress
  const zipName = `resource-deliverables-${Date.now()}.zip`;
  const zipPath = path.join(sourceDir, '..', zipName);
  execSync(`cd ${sourceDir} && zip -q -r ${path.basename(zipPath)} .`);
 
  return {
    success: true,
    zipPath,
    filesProcessed: Object.keys(renames).length,
  };
}
 
async function uploadToSlack(channelId, threadTs, zipPath) {
  const form = new FormData();
  form.append('token', SLACK_BOT_TOKEN);
  form.append('channels', channelId);
  form.append('thread_ts', threadTs);
  form.append('title', 'Resource Deliverables - Renamed');
  form.append('file', fs.createReadStream(zipPath));
 
  const response = await fetch('https://slack.com/api/files.upload', {
    method: 'POST',
    body: form,
  });
 
  const data = await response.json();
  console.log('Upload result:', data);
}
 
app.listen(PORT, () => {
  console.log(`Slack app listening on port ${PORT}`);
});
