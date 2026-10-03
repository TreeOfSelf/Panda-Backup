#!/usr/bin/env node
//Panda Backup v2 - game server supervisor + append-only offsite backups
//https://github.com/TreeOfSelf/Panda-Backup

//Definitions

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VERSION = "2.0.0";
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const configArg = args.find(a => !a.startsWith('--'));
if (!configArg) {
	console.error("Usage: panda-backup <config.json> [--print-key] [--backup-now] [--check]");
	process.exit(1);
}
const configFile = path.resolve(configArg);
const config = JSON.parse(fs.readFileSync(configFile).toString());
const workDir = process.cwd();
const homeDirectory = os.homedir();

//Defaults for optional settings
config.connection.port = config.connection.port || 22;
config.server.prerun = config.server.prerun || [];
config.server.command = config.server.command || {};
const storageName = config.server.storageName || config.server.name;
const remoteId = `${config.server.type}/${storageName}`;
const keyFile = expandHome(config.connection.key || `~/.ssh/panda_${config.server.type}_${storageName}`);
const knownHostsFile = expandHome(config.connection.knownHostsFile || "~/.ssh/panda_known_hosts");
const stateDir = path.join(workDir, ".panda", config.server.name);
const stateFile = path.join(stateDir, "state.json");
const screenName = `${config.server.name}_server`;
const logFile = {
	control : `${config.server.name}_control.log`,
	server : `${config.server.name}_server.log`,
};
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const SERVER_STOP_TIMEOUT_MS = 5 * 60 * 1000;
const UPLOAD_RETRIES = [60, 300, 900]; //Seconds to wait between upload attempts

let shuttingDown = false;
let backupRunning = false;
let lastScheduledRun = null;
let lastWarnMinute = null;

//Lib

function expandHome(p) {
	return p.startsWith("~/") ? path.join(homeDirectory, p.slice(2)) : p;
}

function log(...messageParts) {
	const message = "[" + getDateTime() + "] " + messageParts.join(" ");
	console.log(message);
	try {
		rotateIfLarge(logFile.control);
		fs.appendFileSync(logFile.control, message + "\n");
	} catch (e) {
		console.error("Could not write log file: " + e.message);
	}
}

function debug(...messageParts) {
	if (config.backup.debug) log('\x1b[90m' + messageParts.join(" ") + '\x1b[0m');
}

function rotateIfLarge(file) {
	try {
		if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, file + ".1");
	} catch (e) { /* missing file is fine */ }
}

function formatTime(milliseconds) {
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const hours = Math.floor(milliseconds / 3600000);
	const minutes = Math.floor(milliseconds / 60000) % 60;
	const seconds = Math.floor(milliseconds / 1000) % 60;
	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds % 1000, 3)}`;
}

function timer() {
	const start = Date.now();
	return () => formatTime(Date.now() - start);
}

function getDate() {
	return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in local time zone
}

function getDateTime() {
	return `${getDate()}_${new Date().toTimeString().split(' ')[0]}`;
}

function getTime() {
	const date = new Date();
	return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function getTimeDifference(timeStr1, timeStr2) {
	const [hours1, mins1] = timeStr1.split(':').map(Number);
	const [hours2, mins2] = timeStr2.split(':').map(Number);
	let diffMins = (hours1 * 60 + mins1) - (hours2 * 60 + mins2);
	if (diffMins < 0) diffMins += 24 * 60;
	return `${String(Math.floor(diffMins / 60)).padStart(2, '0')}:${String(diffMins % 60).padStart(2, '0')}`;
}

function getDaysSinceUnixEpoch() {
	return Math.floor(Date.now() / (1000 * 60 * 60 * 24));
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

//Split a shell-style file list ("'world' 'my dir' plain") into words without invoking a shell
function splitFiles(files) {
	if (Array.isArray(files)) return files;
	const words = [];
	let current = null, quote = null;
	for (let i = 0; i < files.length; i++) {
		const ch = files[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === '\\' && quote === '"' && i + 1 < files.length) current += files[++i];
			else current += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			current = current ?? "";
		} else if (ch === '\\' && i + 1 < files.length) {
			current = (current ?? "") + files[++i];
		} else if (/\s/.test(ch)) {
			if (current !== null) words.push(current);
			current = null;
		} else {
			current = (current ?? "") + ch;
		}
	}
	if (quote) throw new Error(`Unterminated quote in files: ${files}`);
	if (current !== null) words.push(current);
	return words;
}

//Run a program without a shell; returns {status, stdout, stderr}
function run(cmd, cmdArgs, options = {}) {
	debug(cmd, cmdArgs.join(" "));
	const result = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
	if (result.error) return { status: -1, stdout: "", stderr: result.error.message };
	return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
}

//Async variant for long running commands so crash detection keeps ticking
function runAsync(cmd, cmdArgs) {
	debug(cmd, cmdArgs.join(" "));
	return new Promise(resolve => {
		const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", d => stderr += d);
		child.on("error", e => resolve({ status: -1, stderr: e.message }));
		child.on("close", status => resolve({ status, stderr }));
	});
}

//Run a trusted shell snippet from the config (start/prerun commands)
function runShell(command) {
	debug(command);
	return run("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
}

function loadState() {
	try {
		return JSON.parse(fs.readFileSync(stateFile, "utf8"));
	} catch (e) {
		return { types: {} };
	}
}

function saveState(state) {
	fs.mkdirSync(stateDir, { recursive: true });
	const tmp = stateFile + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(state, null, "\t"));
	fs.renameSync(tmp, stateFile);
}

function print_swag(){
	console.log(`\x1b[35m
    ██████                        ██████
  ██████████  ████████████████  ██████████
██████████████                ██████████████
████████                            ████████ \x1b[31m▄▀▀▄▀▀▀▄  ▄▀▀█▄   ▄▀▀▄ ▀▄  ▄▀▀█▄▄   ▄▀▀█▄\x1b[35m
██████                                ███████\x1b[32m   █   █ ▐ ▄▀ ▀▄ █  █ █ █ █ ▄▀   █ ▐ ▄▀ ▀▄\x1b[35m
  ██                                    ██   \x1b[33m  █▀▀▀▀    █▄▄▄█ ▐  █  ▀█ ▐ █    █   █▄▄▄█\x1b[35m
  ██                                    ██   \x1b[31m  █       ▄▀   █   █   █    █    █  ▄▀   █\x1b[35m
██        ██████            ██████        ██ \x1b[32m▄▀       █   ▄▀  ▄▀   █    ▄▀▄▄▄▄▀ █   ▄▀\x1b[35m
██      ██████████        ██████████      ██ \x1b[33m▐        ▐   ▐   █    ▐   █     ▐  ▐   ▐\x1b[35m
██    ████████  ██        ██  ████████    ██\x1b[31m▐                ▐        ▐\x1b[35m
██    ████████  ██        ██  ████████    ██ \x1b[32m ▄▀▀█▄▄   ▄▀▀█▄   ▄▀▄▄▄▄   ▄▀▀▄ █  ▄▀▀▄ ▄▀▀▄  ▄▀▀▄▀▀▀▄\x1b[35m
██    ██████████            ██████████    ██ \x1b[33m▐ ▄▀   █ ▐ ▄▀ ▀▄ █ █    ▌ █  █ ▄▀ █   █    █ █   █   █\x1b[35m
██      ██████      ████      ██████      ██ \x1b[31m  █▄▄▄▀    █▄▄▄█ ▐ █      ▐  █▀▄  ▐  █    █  ▐  █▀▀▀▀\x1b[35m
  ██                ████                ██   \x1b[32m  █   █   ▄▀   █   █        █   █   █    █      █\x1b[35m
  ████████▒▒▒▒▒▒▒▒        ▒▒▒▒▒▒▒▒████████   \x1b[33m ▄▀▄▄▄▀  █   ▄▀   ▄▀▄▄▄▄▀ ▄▀   █     ▀▄▄▄▄▀   ▄▀\x1b[35m
████████████▒▒▒▒▒▒▒▒    ▒▒▒▒▒▒▒▒█████████████\x1b[31m    ▐   ▐   ▐    █       █    ▐              █\x1b[35m
██████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████████████ \x1b[32m   ▐            ▐       ▐                   ▐ \x1b[37m  v${VERSION} \x1b[35m
██████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████████████
██████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████████████\x1b[36m  Running Backup For:       \x1b[37m${config.server.type} - ${config.server.name}\x1b[35m
  ████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒████████████  \x1b[36m  Backup Time:              \x1b[37m${config.backup.time}\x1b[35m
    ████████  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  ████████
                ▒▒▒▒▒▒▒▒▒▒▒▒
                  ▒▒▒▒▒▒▒▒\x1b[36m  ʙʏ: sᴇʙᴀsᴛɪᴀɴ\x1b[35m
                    ▒▒▒▒\x1b[36m  github.com/TreeOfSelf
					\x1b[0m`);
}

//Server

function server_is_running(){
	//Match the exact session name, e.g. "12345.minecraft_server	(Detached)"
	const output = run("screen", ["-list"]).stdout;
	return output.split("\n").some(line => line.trim().split(/\s+/)[0]?.replace(/^\d+\./, "") === screenName);
}

function server_start(){
	log(`Starting server for ${config.server.type} - ${config.server.name}`);
	//Keep the previous server log for crash forensics instead of deleting it
	try { fs.renameSync(logFile.server, logFile.server + ".1"); } catch (e) { /* first start */ }
	//The start command is trusted config and may use shell features, as before
	runShell(`screen -L -Logfile ${shellQuote(logFile.server)} -dmS ${shellQuote(screenName)} ${config.server.command.start}`);
}

function server_command(command){
	run("screen", ["-S", screenName, "-p", "0", "-X", "stuff", command + "\r"]);
}

function server_warn(warning){
	log(warning);
	server_command(`${config.server.command.say} ${warning}`);
}

async function server_stop(){
	if (!server_is_running()) return;
	log("Stopping server");
	if (config.server.command.stop) {
		server_command(config.server.command.stop);
	} else {
		run("screen", ["-S", screenName, "-X", "quit"]);
	}
	const deadline = Date.now() + SERVER_STOP_TIMEOUT_MS;
	while (server_is_running()) {
		if (Date.now() > deadline) {
			log("Server did not stop in time, closing screen session");
			run("screen", ["-S", screenName, "-X", "quit"]);
			await sleep(5000);
			break;
		}
		await sleep(1000);
	}
}

function shellQuote(s) {
	return "'" + String(s).replaceAll("'", "'\\''") + "'";
}

//Staging - copy configured files to a private folder so the server can restart quickly

//Mount points from the kernel, used to skip bind mounts (eg FastDL folders mounted into html)
function getMountPoints() {
	try {
		return fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(Boolean)
			.map(line => line.split(" ")[4].replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8))));
	} catch (e) {
		return [];
	}
}

//Where an entry lives inside the archive: relative paths stay relative, anything absolute or using ".." is stored by its absolute path
function archivePathFor(entry) {
	const normalized = path.normalize(entry).replace(/\/+$/, "");
	if (!path.isAbsolute(normalized) && !normalized.startsWith("..")) return normalized;
	return path.resolve(workDir, normalized).replace(/^\/+/, "");
}

function rsyncPattern(p) {
	return p.replace(/([*?[\\])/g, "\\$1");
}

function stageFiles(backupName, backup, stagingDir) {
	const mounts = backup.allowCrossFilesystem ? [] : getMountPoints();
	let copied = 0;
	for (const entry of splitFiles(backup.files)) {
		const source = path.resolve(workDir, entry);
		let stat;
		try {
			stat = fs.lstatSync(source);
		} catch (e) {
			log(`WARNING: ${backupName}: "${entry}" does not exist, skipping`);
			continue;
		}
		//Follow symlinks that are listed directly (eg config files linked from a git repo)
		const realSource = stat.isSymbolicLink() ? fs.realpathSync(source) : source;
		const isDir = fs.statSync(realSource).isDirectory();
		const destination = path.join(stagingDir, archivePathFor(entry));
		fs.mkdirSync(path.dirname(destination), { recursive: true });

		const rsyncArgs = ["-a"];
		if (isDir) {
			const canonical = fs.realpathSync(realSource);
			for (const mount of mounts) {
				if (mount.startsWith(canonical + "/")) {
					debug(`Skipping mount point ${mount}`);
					rsyncArgs.push(`--exclude=/${rsyncPattern(mount.slice(canonical.length + 1))}/`);
				}
			}
			rsyncArgs.push(realSource + "/", destination + "/");
		} else {
			rsyncArgs.push(realSource, destination);
		}
		const result = run("rsync", rsyncArgs);
		//24 = some files vanished during copy (eg rotating logs), not fatal
		if (result.status !== 0 && result.status !== 24) {
			log(`WARNING: ${backupName}: copy of "${entry}" exited ${result.status}: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
		}
		copied++;
	}
	return copied;
}

//Archive - tar the staging folder, hashing the uncompressed stream for change detection

function compressorFor(backup) {
	const has = bin => run("sh", ["-c", `command -v ${bin}`]).status === 0;
	switch (backup.compression) {
		case "xz":
			return { ext: "xz", cmd: "xz", args: backup.threaded ? ["-T0", "-c"] : ["-c"] };
		case "zst":
		case "zstd":
			return { ext: "zst", cmd: "zstd", args: [backup.threaded ? "-T0" : "-T1", "-q", "-c", "-10"] };
		case "bz2":
		default:
			if (backup.threaded && has("lbzip2")) return { ext: "bz2", cmd: "lbzip2", args: ["-c"] };
			return { ext: "bz2", cmd: "bzip2", args: ["-c"] };
	}
}

function lowPriority(cmd, cmdArgs) {
	return ["ionice", ["-c3", "nice", "-n", "19", cmd, ...cmdArgs]];
}

function createArchive(stagingDir, archiveFile, backup) {
	return new Promise((resolve, reject) => {
		//List top level entries rather than "." so extracting never changes the permissions of the restore folder
		const entries = fs.readdirSync(stagingDir).sort();
		const tarArgs = ["-cf", "-", "--sort=name", "--numeric-owner", "--owner=0", "--group=0", "-C", stagingDir, "--", ...entries];
		if (!entries.length) tarArgs.splice(tarArgs.indexOf("--"), 2 + entries.length, "--files-from=/dev/null");
		if (backup.stripTimestamps) tarArgs.splice(2, 0, "--mtime=1970-04-20 00:00:00");
		const compressor = compressorFor(backup);
		const hash = crypto.createHash("sha256");
		const tar = spawn(...lowPriority("tar", tarArgs), { stdio: ["ignore", "pipe", "pipe"] });
		const out = fs.openSync(archiveFile, "w", 0o600);
		const zip = spawn(...lowPriority(compressor.cmd, compressor.args), { stdio: ["pipe", out, "pipe"] });
		fs.closeSync(out);
		let stderr = "";
		tar.stderr.on("data", d => stderr += d);
		zip.stderr.on("data", d => stderr += d);
		tar.stdout.on("data", chunk => hash.update(chunk));
		tar.stdout.pipe(zip.stdin);
		const codes = {};
		const done = (name, code) => {
			codes[name] = code;
			if (!("tar" in codes && "zip" in codes)) return;
			if (codes.tar !== 0 || codes.zip !== 0) return reject(new Error(`tar=${codes.tar} ${compressor.cmd}=${codes.zip} ${stderr.trim()}`));
			resolve(hash.digest("hex"));
		};
		tar.on("close", code => done("tar", code));
		zip.on("close", code => done("zip", code));
	});
}

function verifyArchive(archiveFile) {
	const result = run("tar", ["--force-local", "-tf", archiveFile]);
	if (result.status !== 0) throw new Error(`archive failed verification: ${result.stderr.trim()}`);
	return result.stdout.split("\n").filter(Boolean).length;
}

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		fs.createReadStream(file).on("data", d => hash.update(d)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
	});
}

//Remote - write-only rsync into this server's own folder (restricted by the storage server)

function sshCommand() {
	return ["ssh", "-i", keyFile, "-p", String(config.connection.port),
		"-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no",
		"-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`,
		"-o", "ServerAliveInterval=30", "-o", "ConnectTimeout=30"].map(shellQuote).join(" ");
}

function remote_upload(folder, files) {
	const destination = `${config.connection.username}@${config.connection.ip}:${folder}/`;
	return runAsync("rsync", ["-e", sshCommand(), "--mkpath", "--timeout=600", ...files, destination]);
}

async function remote_upload_retry(folder, files) {
	for (let attempt = 0; ; attempt++) {
		const elapsed = timer();
		const result = await remote_upload(folder, files);
		if (result.status === 0) {
			log(`Uploaded ${path.basename(files[0])} to ${remoteId}/${folder} in ${elapsed()}`);
			return true;
		}
		log(`Upload to ${folder} failed (exit ${result.status}): ${result.stderr.trim().split("\n").slice(-2).join(" | ")}`);
		if (attempt >= UPLOAD_RETRIES.length || shuttingDown) return false;
		log(`Retrying in ${UPLOAD_RETRIES[attempt]}s`);
		await sleep(UPLOAD_RETRIES[attempt] * 1000);
	}
}

//Key + host key setup. No passwords: the storage admin authorizes each key once.

function setupSsh() {
	fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
	if (!fs.existsSync(keyFile)) {
		log("Generating SSH key " + keyFile);
		run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `panda:${remoteId}`, "-f", keyFile]);
	}
	if (config.connection.hostKey) {
		const hostEntry = config.connection.port == 22 ? config.connection.ip : `[${config.connection.ip}]:${config.connection.port}`;
		const line = `${hostEntry} ${config.connection.hostKey.trim()}\n`;
		let existing = "";
		try { existing = fs.readFileSync(knownHostsFile, "utf8"); } catch (e) { /* new file */ }
		if (!existing.includes(line)) fs.appendFileSync(knownHostsFile, line, { mode: 0o600 });
	}
	if (config.connection.password !== undefined) {
		log("WARNING: connection.password is no longer used and should be removed from " + configFile);
	}
}

function authorizedKeysLine() {
	const publicKey = fs.readFileSync(keyFile + ".pub", "utf8").trim();
	return `restrict,command="/usr/bin/rrsync -wo -no-del -no-overwrite -munge servers/${remoteId}" ${publicKey}`;
}

//Backup

function cleanupStaleFiles() {
	//Leftovers from interrupted runs of this version
	fs.rmSync(path.join(stateDir, "staging"), { recursive: true, force: true });
	fs.rmSync(path.join(stateDir, "archives"), { recursive: true, force: true });
	//Leftovers from v1 (temp_<type> folders and archives in the working directory)
	for (const backupName in config.backup.types) {
		fs.rmSync(path.join(workDir, `temp_${backupName}`), { recursive: true, force: true });
	}
	const legacyArchive = new RegExp(`^${config.server.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(${Object.keys(config.backup.types).join("|")})_\\d{4}-\\d{2}-\\d{2}_\\d{2}:\\d{2}:\\d{2}\\.tar\\.(bz2|xz)$`);
	for (const file of fs.readdirSync(workDir)) {
		if (legacyArchive.test(file)) {
			log(`Removing leftover archive ${file}`);
			fs.rmSync(path.join(workDir, file), { force: true });
		}
	}
}

function slotsDue(backup, typeState) {
	const kind = backup.type;
	const freq = Math.max(1, backup.shortFreq || 1);
	const slots = [];
	const longDue = new Date().getDate() === config.backup.longBackupDay || !typeState.lastLong;
	if ((kind === "long" || kind === "both") && longDue) slots.push("long");
	const shortDue = getDaysSinceUnixEpoch() % freq === 0 || !typeState.lastShort;
	//On long days "both" types also refresh short, matching v1
	if ((kind === "short" || kind === "both") && (shortDue || slots.includes("long"))) slots.push("short");
	return slots;
}

async function server_backup(){
	//Prevent overlapping backups and let crash detection know a backup owns the server
	if (backupRunning) {
		log("Backup already running, skipping");
		return;
	}
	backupRunning = true;
	try {
		await run_backup();
	} catch (e) {
		log("BACKUP FAILED: " + e.stack);
	} finally {
		backupRunning = false;
		fs.rmSync(path.join(stateDir, "staging"), { recursive: true, force: true });
		fs.rmSync(path.join(stateDir, "archives"), { recursive: true, force: true });
	}
}

async function run_backup(){
	log(`Backing up ${config.server.type} - ${config.server.name}`);
	const state = loadState();
	const dateTime = getDateTime();
	const stagingRoot = path.join(stateDir, "staging");
	const archiveRoot = path.join(stateDir, "archives");
	fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
	const restarting = config.server.runs && config.server.restartOnBackup;

	//Work out what is due before stopping anything
	const work = [];
	for (const backupName in config.backup.types) {
		const backup = config.backup.types[backupName];
		const typeState = state.types[backupName] = state.types[backupName] || {};
		const slots = slotsDue(backup, typeState);
		if (slots.length) work.push({ backupName, backup, typeState, slots });
	}
	//Servers that restart on backup still get their daily restart and prerun commands, as in v1
	if (!work.length && !restarting) {
		log("Nothing due today");
		return;
	}

	let failures = 0;
	try {
		if (restarting) await server_stop();

		//Run prerun commands
		if (config.server.prerun.length > 0) {
			log(`Running ${config.server.prerun.length} prerun commands`);
			for (const command of config.server.prerun) {
				const result = runShell(command);
				if (result.status !== 0) log(`WARNING: prerun command exited ${result.status}: ${result.stderr.trim().split("\n").slice(-2).join(" | ")}`);
			}
		}

		for (const item of work) {
			const elapsed = timer();
			item.staging = path.join(stagingRoot, item.backupName);
			fs.mkdirSync(item.staging, { recursive: true, mode: 0o700 });
			stageFiles(item.backupName, item.backup, item.staging);
			log(`Completed copy for ${item.backupName} in ${elapsed()}`);
		}
	} finally {
		//Start server back up as soon as files are copied
		if (restarting && !shuttingDown) server_start();
	}

	for (const item of work) {
		const { backupName, backup, typeState, slots } = item;
		try {
			const compressor = compressorFor(backup);
			const fileName = `${config.server.name}_${backupName}_${dateTime}.tar.${compressor.ext}`;
			const archiveFile = path.join(archiveRoot, fileName);
			log(`Creating backup ${backupName} - compression: ${compressor.cmd}`);
			const elapsed = timer();
			const contentHash = await createArchive(item.staging, archiveFile, backup);
			fs.rmSync(item.staging, { recursive: true, force: true });
			const entries = verifyArchive(archiveFile);
			const size = fs.statSync(archiveFile).size;
			log(`Completed compression for ${backupName} in ${elapsed()} (${entries} entries, ${(size / 1048576).toFixed(1)} MiB)`);
			if (entries === 0) log(`WARNING: ${backupName} archive is empty, check the files list`);

			typeState.lastHash = typeState.lastHash || {};
			const pending = slots.filter(slot => typeState.lastHash[slot] !== contentHash);
			for (const slot of slots.filter(slot => !pending.includes(slot))) {
				log(`Did not upload to ${backupName}/${slot}, content unchanged.`);
				typeState[slot === "long" ? "lastLong" : "lastShort"] = getDate();
			}
			if (pending.length) {
				//Sidecar checksum lets the storage server verify the transfer
				fs.writeFileSync(archiveFile + ".sha256", `${await sha256File(archiveFile)}  ${fileName}\n`);
				for (const slot of pending) {
					if (await remote_upload_retry(`${backupName}/${slot}`, [archiveFile, archiveFile + ".sha256"])) {
						typeState.lastHash[slot] = contentHash;
						typeState[slot === "long" ? "lastLong" : "lastShort"] = getDate();
					} else {
						failures++;
					}
				}
			}
			fs.rmSync(archiveFile, { force: true });
			fs.rmSync(archiveFile + ".sha256", { force: true });
		} catch (e) {
			failures++;
			log(`BACKUP FAILED for ${backupName}: ${e.message}`);
		}
		saveState(state);
	}

	state.lastRun = { at: getDateTime(), failures };
	saveState(state);
	log(failures ? `Backup finished with ${failures} failure(s)` : "Backup complete!");
}

//Lifecycle

async function graceful_shutdown(signal){
	if (shuttingDown) return;
	shuttingDown = true;
	log(`${signal} received, exiting`);
	//By default the game server keeps running in its screen session so updating or restarting panda never kicks players
	if (config.server.runs && config.server.stopOnExit) await server_stop();
	process.exit(0);
}

process.on('SIGINT', () => graceful_shutdown("SIGINT"));
process.on('SIGTERM', () => graceful_shutdown("SIGTERM"));

function tick() {
	const currentTime = getTime();
	const timeDifference = getTimeDifference(config.backup.time, currentTime);

	if (config.server.runs && !backupRunning && !shuttingDown) {
		if (config.server.crashDetection && !server_is_running()) {
			log("Crash detected, restarting server");
			server_start();
		} else if (config.server.restartOnBackup && config.server.warnBackup && lastWarnMinute !== currentTime) {
			const warnings = {
				"01:00": "1 hour to server restart.",
				"00:30": "30 minutes to server restart.",
				"00:15": "15 minutes to server restart.",
				"00:10": "10 minutes to server restart.",
				"00:05": "5 minutes to server restart.",
				"00:01": "1 minute to server restart.",
				"00:00": "Server restarting...",
			};
			if (warnings[timeDifference]) {
				lastWarnMinute = currentTime;
				server_warn(warnings[timeDifference]);
			}
		}
	}

	if (timeDifference === "00:00" && lastScheduledRun !== getDate()) {
		lastScheduledRun = getDate();
		server_backup();
	}
}

async function start(){
	print_swag();
	log(`Panda Backup v${VERSION} starting (${configFile})`);
	setupSsh();

	if (flags.has("--print-key")) {
		console.log(authorizedKeysLine());
		process.exit(0);
	}

	if (flags.has("--check")) {
		const result = await remote_upload(".", ["--dry-run", configFile]);
		console.log(result.status === 0 ? "Storage connection OK" : `Storage connection FAILED: ${result.stderr.trim()}`);
		process.exit(result.status === 0 ? 0 : 1);
	}

	cleanupStaleFiles();

	if (flags.has("--backup-now")) {
		await server_backup();
		process.exit(0);
	}

	//Adopt a server that is already running instead of restarting it
	if (config.server.runs) {
		if (server_is_running()) {
			log("Server already running, leaving it up");
		} else {
			server_start();
		}
	}

	setInterval(tick, 15 * 1000);
}

start();
