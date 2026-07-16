"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const target = process.argv[2];
if (!target) throw new Error("Missing tinySSB web directory");

const htmlPath = path.join(target, "tremola.html");
const boardPath = path.join(root, "miniApps/collabboard/resources/board.html");
const marker = "<!-- COLLABBOARD_CONTENT -->";
const html = fs.readFileSync(htmlPath, "utf8");
if (!html.includes(marker)) throw new Error("tinySSB integration marker is missing");
fs.writeFileSync(htmlPath, html.replace(marker, fs.readFileSync(boardPath, "utf8")));
