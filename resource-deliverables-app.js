#!/usr/bin/env node

/**
 * Nationwide SCS - Resource Deliverables Slack App
 * 
 * Triggers on:
 * - Slash command: /resource-deliverables (with attached file)
 * - Message containing "resource deliverables" (with attached file)
 * 
 * Processes: Downloads the attachment, renames photos using Claude vision,
 * compresses, and posts the result back to the same channel.
 * 
 * Deploy to Vercel with environment variables:
 * - SLACK_BOT_TOKEN
 * - SLACK_SIGNING_SECRET
 * - ANTHROPIC_API_KEY
 */

import { App, ExpressReceiver } from "@slack/bolt";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";
import AdmZip from "adm-zip";

// Environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!SLACK_BOT_TOKEN || !SLACK_SIGNING_SECRET || !ANTHROPIC_API_KEY) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Setup Express receiver for Slack
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// Subject vocabulary (from rename-site-photos skill)
const SUBJECTS = {
  Rack: "Open or enclosed rack",
  Cabinet: "Enclosed cabinet",
  "Patch-Panel": "Copper or fiber patch panel",
  Switch: "Single switch",
  "Switch-Stack": "Stacked or multiple switches",
  AP: "Wireless access point",
  "Data-Jack": "Jack, outlet, faceplate",
  Faceplate: "Faceplate",
  "Fiber-Enclosure": "Fiber housing, cassette",
  Fiber: "Fiber cable, trunk, run",
  "Cable-Tray": "Tray, ladder rack, basket",
  "J-Hook": "J-hooks and supports",
  Conduit: "Conduit, sleeve, core",
  Pathway: "Pathway (mixed)",
  "Ground-Bar": "Bonding, grounding",
  UPS: "UPS unit",
  PDU: "Power strip, PDU",
  "Cable-Mgmt": "Cable managers",
  Label: "Close shot of label",
  Demarc: "Demarc, MPOE",
  "Telecom-Room": "Room shot",
  Riser: "Riser, backbone",
  Camera: "Cameras and endpoints",
  Ceiling: "Above-ceiling",
  "Wall-Field": "Backboard, wall-mounted",
  "Existing-Conditions": "Pre-work, damage",
  "Test-Results": "Tester screen, cert",
  Exterior: "Building exterior",
  "Floor-Plan": "Plan, marked-up drawing",
  Overview: "Wide establishing shot",
  Misc: "Unclassified",
};

// Download file from URL
async function downloadFile(url, filepath, token) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };
    const file = fs.createWriteStream(filepath);
    https
      .get(url, options, (response) => {
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
  });
}

// Convert image to base64
function imageToBase64(filepath) {
  return fs.readFileSync(filepath).toString("base64");
}

// Get media type from extension
function getMediaType(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const types = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return types[ext] || "image/jpeg";
}

// Analyze photo with Claude vision
async function analyzePhoto(filepath) {
  try {
    const base64 = imageToBase64(filepath);
    const mediaType = getMediaType(filepath);

    const response = await anthropic.messages.create({
      model: "claude-opus-4-1-20250805",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: base64,
              },
            },
            {
              type: "text",
              text: `Analyze this infrastructure photo. Respond ONLY with JSON (no markdown):
{
  "subject": "one of: Rack, Cabinet, Patch-Panel, Switch, Switch-Stack, AP, Data-Jack, Faceplate, Fiber-Enclosure, Fiber, Cable-Tray, J-Hook, Conduit, Pathway, Ground-Bar, UPS, PDU, Cable-Mgmt, Label, Demarc, Telecom-Room, Riser, Camera, Ceiling, Wall-Field, Existing-Conditions, Test-Results, Exterior, Floor-Plan, Overview, Misc",
  "detail": "null or: visible label, room number, space name",
  "variant": "null or: WIDE, CLOSE, REAR, FRONT, LABEL, BEFORE, AFTER",
  "confidence": "high, medium, or low"
}`,
            },
          ],
        },
      ],
    });

    const content = response.content[0].type === "text" ? response.content[0].text : "";
    try {
      return JSON.parse(content);
    } catch (e) {
      return { subject: "Misc", detail: null, variant: null, confidence: "low" };
    }
  } catch (error) {
    console.error(`Vision analysis error: ${error.message}`);
    return { subject: "Misc", detail: null, variant: null, confidence: "low" };
  }
}

// Build filename from components
function buildFilename(subject, detail, variant, number, ext) {
  let name = subject;
  if (detail) name += `-${detail}`;
  if (variant) name += `-${variant}`;
  name += `-${String(number).padStart(2, "0")}`;
  return name + ext;
}

// Process photos in a directory
async function processPhotos(sourceDir) {
  const imageExtensions = [".jpg", ".jpeg", ".png"];
  const files = fs
    .readdirSync(sourceDir)
    .filter((f) => imageExtensions.includes(path.extname(f).toLowerCase()));

  if (files.length === 0) {
    return { success: false, message: "No image files found in attachment" };
  }

  // Analyze each photo
  const analyses = {};
  const errors = [];

  for (const file of files) {
    try {
      const filepath = path.join(sourceDir, file);
      const analysis = await analyzePhoto(filepath);
      analyses[file] = analysis;
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
    }
  }

  if (Object.keys(analyses).length === 0) {
    return { success: false, message: "Failed to analyze images" };
  }

  // Build rename mapping with deduplication
  const nameGroups = {};
  const renames = {};

  for (const file of files) {
    if (!analyses[file]) continue;

    const analysis = analyses[file];
    const ext = path.extname(file);
    const key = `${analysis.subject}|${analysis.detail || ""}|${analysis.variant || ""}`;

    if (!nameGroups[key]) nameGroups[key] = [];
    nameGroups[key].push(file);
  }

  // Assign numbers to each group
  for (const [key, fileGroup] of Object.entries(nameGroups)) {
    const [subject, detail, variant] = key.split("|");
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

  // Perform renames
  for (const [old, newName] of Object.entries(renames)) {
    const oldPath = path.join(sourceDir, old);
    const newPath = path.join(sourceDir, newName);
    fs.renameSync(oldPath, newPath);
  }

  // Compress
  const timestamp = Date.now();
  const zipPath = path.join(sourceDir, `..`, `resource-deliverables-${timestamp}.zip`);
  execSync(`cd ${sourceDir} && zip -q -r ${path.basename(zipPath)} .`);

  return {
    success: true,
    zipPath,
    filesProcessed: Object.keys(renames).length,
    renames,
    errors,
  };
}

// Handle slash command
app.command("/resource-deliverables", async ({ ack, body, client }) => {
  await ack();

  const { trigger_id, channel_id, user_id } = body;

  // Open modal to accept file upload OR redirect to message instruction
  await client.views.open({
    trigger_id,
    view: {
      type: "modal",
      callback_id: "resource_deliverables_modal",
      title: {
        type: "plain_text",
        text: "Resource Deliverables",
      },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Post a message with your file in this channel and say *resource deliverables*. The automation will process it immediately.",
          },
        },
      ],
      close: {
        type: "plain_text",
        text: "Close",
      },
    },
  });
});

// Handle message events
app.message("resource deliverables", async ({ message, say, client }) => {
  // Only process messages with files
  if (!message.files || message.files.length === 0) {
    await say("Please attach a file with photos to process.");
    return;
  }

  const file = message.files[0];
  const channelId = message.channel;
  const threadTs = message.ts;

  // Acknowledge with reaction
  await client.reactions.add({
    channel: channelId,
    timestamp: threadTs,
    emoji: "hourglass_flowing_sand",
  });

  try {
    // Create temp directory for processing
    const tempDir = path.join("/tmp", `resource-${Date.now()}`);
    const extractDir = path.join(tempDir, "extracted");
    fs.mkdirSync(extractDir, { recursive: true });

    // Download file
    const downloadPath = path.join(tempDir, file.name);
    await downloadFile(file.url_private, downloadPath, SLACK_BOT_TOKEN);

    // Extract if ZIP
    if (file.name.endsWith(".zip")) {
      const zip = new AdmZip(downloadPath);
      zip.extractAllTo(extractDir, true);
    } else {
      // Single file or copy directly
      fs.copyFileSync(downloadPath, path.join(extractDir, file.name));
    }

    // Process photos
    const result = await processPhotos(extractDir);

    // Remove hourglass reaction
    await client.reactions.remove({
      channel: channelId,
      timestamp: threadTs,
      emoji: "hourglass_flowing_sand",
    });

    if (!result.success) {
      await say({
        thread_ts: threadTs,
        text: `Failed to process files: ${result.message}`,
      });
      return;
    }

    // Upload result
    const uploadResult = await client.files.upload({
      channels: channelId,
      file: fs.createReadStream(result.zipPath),
      filename: path.basename(result.zipPath),
      thread_ts: threadTs,
      title: "Resource Deliverables - Renamed",
    });

    // Post summary
    await say({
      thread_ts: threadTs,
      text: `Processed ${result.filesProcessed} photos. Renamed and compressed.`,
    });

    // Add checkmark reaction
    await client.reactions.add({
      channel: channelId,
      timestamp: threadTs,
      emoji: "white_check_mark",
    });

    // Cleanup
    fs.rmSync(tempDir, { recursive: true });
  } catch (error) {
    console.error("Error processing file:", error);
    await client.reactions.add({
      channel: channelId,
      timestamp: threadTs,
      emoji: "x",
    });
    await say({
      thread_ts: threadTs,
      text: `Error processing file: ${error.message}`,
    });
  }
});

// Health check endpoint
receiver.app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start server
const PORT = process.env.PORT || 3000;
receiver.app.listen(PORT, () => {
  console.log(`Slack app listening on port ${PORT}`);
});
