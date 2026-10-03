<p align="center">
  <img src="https://sebastiancodes.online/github/pandabackup.png">
</p>

# Panda Backup

Panda Backu is a tool for originally intended to allow my Minecraft servers to have an automated backup that wasn't dependant on the server software running. It has evolved into something much greater, and can be used to customize different types of backups for any type of server, preform automated restarts, run pre-run commands (in my case, I prune chunks in Minecraft at server restart), and more!

## How it works (v2)

Each server runs its own `panda-backup` process (eg under PM2). It supervises the game server in a `screen` session (crash detection, scheduled restarts with in-game warnings, prerun commands) and once a day copies the configured files, compresses them and uploads them over rsync.

Backups are **append-only**. Every server gets its own SSH key, and the storage server only lets that key *write new files* into that server's folder:

```
restrict,command="/usr/bin/rrsync -wo -no-del -no-overwrite -munge servers/minecraft/survival" ssh-ed25519 AAAA... panda:minecraft/survival
```

A compromised game server can't read, overwrite or delete any backups, including its own. Pruning, verification and restore testing happen on the storage server ([`storage/panda_storage.py`](storage/panda_storage.py)), which nothing on the game servers can reach.

There are no passwords anywhere. The storage host key is pinned in the config.

## Prerequisites

- Node.js 18+
- `rsync`, `screen`, `tar`, `ionice`
- A storage server reachable over SSH with `rsync`, `rrsync` (ships with rsync 3.2.4+) and `python3`
### OPTIONAL
- `lbzip2` for threaded bz2 compression (used automatically when `threaded` is on)
- `zstd` for `"compression": "zst"`

## Installation

1. Put `panda-backup.js` in `/usr/share/panda_backup.js` so every user can run it.
2. Create a config (see below) next to the server, then authorize its key on the storage server:
   ```
   node /usr/share/panda_backup.js my_backup.json --print-key
   ```
   Append the printed line to `~/.ssh/authorized_keys` on the storage server and create the folder it names (eg `mkdir -p ~/servers/minecraft/survival`), since rrsync refuses a folder that doesn't exist.
3. Check the connection: `node /usr/share/panda_backup.js my_backup.json --check`
4. Run it under PM2:
   ```
   pm2 start /usr/share/panda_backup.js --name "example" -- my_backup.json
   ```

### Storage server

1. Copy `storage/panda_storage.py` to `~/panda/panda_storage.py`.
2. Create `~/panda/retention.json` with one entry per `type/name/backupType`:
   ```json
   { "minecraft/survival/world": { "short": 7, "long": 0, "shortFreq": 1, "expect_short": true, "expect_long": true } }
   ```
   Folders without an entry are never pruned.
3. Add a cron job, eg every 30 minutes: `/usr/bin/python3 ~/panda/panda_storage.py`. Set `MAILTO` to be emailed when something is wrong. It only prints when there is a problem.
4. Run `python3 ~/panda/panda_storage.py --dry-run` first to see what it would prune.

On each run it:
- verifies new archives (sidecar sha256 plus a full decompress and list)
- moves archives that fail into `~/panda/quarantine`
- prunes by `retention.json`, but never deletes anything younger than the retention window, so a flood of junk uploads can't push out good backups
- once a day, re-verifies up to 5 GB of older archives, so restores are known to work
- writes `~/panda/status.txt` and `status.json`

## Features

- Automatic daily backups with short-term and monthly long-term retention
- Append-only, per-server restricted storage access with no passwords
- Uploads verified on arrival, plus continuous restore testing on the storage side
- Doesn't upload an archive whose contents haven't changed (hash of the uncompressed tar, so the compressor doesn't matter)
- Reproducible archives (sorted, numeric owners, optional fixed timestamps)
- Skips bind mounts inside backed up folders (eg FastDL folders mounted into a web root) unless `allowCrossFilesystem` is set
- Symlinks listed directly in `files` are followed (eg configs linked from a git repo)
- Adopts an already running server on start, so updating or restarting panda never kicks players
- Prerun commands, crash detection, restart warnings
- Cleans up leftovers from interrupted runs; logs rotate instead of being deleted

## Command line

| Flag | Does |
| --- | --- |
| `--print-key` | Print the `authorized_keys` line for this server and exit |
| `--check` | Test the storage connection and exit |
| `--backup-now` | Run a backup immediately and exit. **Stops the server first if `restartOnBackup` is on** |

## Example configuration example_backup.json
```
{
	"connection": {
		"ip": "storage.example.com",
		"port": 22,
		"username": "USERNAME HERE",
		"hostKey": "ssh-ed25519 AAAA... (from: ssh-keyscan -t ed25519 storage.example.com)"
		//Optional: "key": "~/.ssh/my_key" (default ~/.ssh/panda_<type>_<name>)
	},
	"server": {
		"type": "minecraft", //Game type, first folder on the storage server
		"name": "test",  //Server name, also the screen session name (<name>_server)
		//Optional: "storageName": "other_name" to use a different folder on the storage server
		"runs": true, //Whether or not this is something that "runs", false would mean its just a folder you want to automate backing up
		"warnBackup": true, //Whether to broadcast warnings of incoming server reset
		"crashDetection": true, //Whether to enable automatic crash restart detection
		"restartOnBackup": true, //Whether or not to turn off and on the server on backup
		"stopOnExit": false, //Whether stopping panda (Ctrl+C, pm2 stop/restart) also stops the server. Default false
		"command": {
			"start": "java -jar server.jar nogui", //Command to start server
			"stop": "stop", //Stop server command, typed into the console
			"say": "say" //Broadcast message command
		},
		"prerun": [  //Shell commands to run before copying files (server is stopped if restartOnBackup)
			"java -jar /usr/local/bin/mcaselector.jar --mode delete --world 'world' --query 'InhabitedTime < 1min'"
		]
	},
	"backup": {
		"debug": false, //Whether or not to print debug messages
		"time": "04:00", //24hr local time to back up (and restart the server)
		"longBackupDay": 1, //What day of the month to do long backups
		"types": { //Types of backups
			"world": {
				"type": "both", //"long", "short", or "both"
				"compression": "xz", //xz, bz2 or zst
				"threaded": true, //Use all cores
				"stripTimestamps": false, //Fix file timestamps so unchanged content gives an identical archive
				"shortLimit": 7, //Short backups to keep (enforced by the storage server)
				"longLimit": 0, //Long backups to keep, 0 = forever
				"shortFreq": 1, //Do a short backup once every x days
				"files": "'world' 'world_nether' 'world_the_end'" //Files to back up: shell-style quoted list, or a JSON array
				//Optional: "allowCrossFilesystem": true to include bind mounts inside these folders
			}
		}
	}
}
```

Paths in `files` are relative to the folder panda runs in. Relative paths are stored as-is in the archive, while absolute paths and paths using `..` are stored under their absolute path (eg `home/user/html/site/...`).

## Restoring

Archives live on the storage server at `servers/<type>/<name>/<backupType>/<short|long>/`. Copy one back with an admin account (not a server's restricted key) and extract it:
```
tar -xf survival_world_2026-10-03_04:00:00.tar.xz -C /restore/here
```

## Upgrading from v1

- Remove `connection.password` and add `connection.hostKey`.
- Run with `--print-key` and authorize the key on the storage server, then `--check`.
- Restart the panda process. It adopts the running server instead of restarting it. With v1 still running, use `kill -9` on the node process so v1's Ctrl+C handler doesn't stop the server; PM2 restarts it on the new version.
- Retention moves to `retention.json` on the storage server.
- Remove the old `id_rsa` keys from the storage server's `authorized_keys` once every server is on v2.

## Contributing

Pull requests are welcome. For major changes, please open an issue first
to discuss what you would like to change.

## License

CC0
