<p align="center">
  <img src="https://sebastiancodes.online/github/pandabackup.png">
</p>

# Panda Backup

Panda Backu is a tool for originally intended to allow my Minecraft servers to have an automated backup that wasn't dependant on the server software running. It has evolved into something much greater, and can be used to customize different types of backups for any type of server, preform automated restarts, run pre-run commands (in my case, I prune chunks in Minecraft at server restart), and more!

## Prerequisites

- Node.js
- An rsync capable backup server (because it often isn't tracked as actual bandwidth on storage servers)
### OPTIONAL
- lbzip2 for threaded bz2 compression (chosen for it's balance between small compression size and speed)
- Ipixz for threaded xz compression (chosen for its very good compression ratio, it is slow though)

## Installation

1. Put panda-backup.js in `/usr/share/panda_backup.js` to allow it to be accessed by any user.
2. Edit `/etc/bash.bashrc` adding the line `alias panda-backup="node /usr/share/panda_backup.js"` at the end.
3. On any user, type `panda-backup backup-config.json` supplying it with your backup configuration file. Running in a screen, or PM2 is possible too. 

### for PM2 it can be started as:
`pm2 start /usr/share/panda_backup.js --name "example" -- example_backup.json`

## Features

- Automatic backups
- Prerun commands
- Customizable types of backups
- Backup frequencies
- Amount of backups to store back
- Long term once a month or short term backups
- Doesn't save backup if the previous backup has the same data
- Lightweight
- Easy to install, edit, and use

## Example configuration
```
{
{
	"connection": {
		"ip": "IP HERE",
		"port": 22,
		"username": "USERNAME HERE",
		"password": "PASSWORD HERE"
	},
	"server": {
		"type": "minecraft", //Game type
		"name": "test",  //Server name
		"runs": true, //Whether or not this is something that "runs", false would mean its just a folder you want to automate backing up
		"warnBackup": true, //Whether to broadcast warnings of incoming server reset
		"crashDetection": true, //Whether to enable automatic crash restart detection
		"restartOnBackup": true, //Whether or not to turn off and on the server on backup 
		"command": {
			"start": "java jar server.jar nogui", //Comand to start server
			"stop": "stop", //Stop server command
			"say": "say" //Broadcast message command
		},
		"prerun": [  //Commands to run before compressing 
			"java -jar /usr/local/bin/mcaselector.jar --mode delete --world 'world' --query 'InhabitedTime < 1min'",  //For example this prunes minecraft chunks
			"grep -v '^#' server.properties > server.properties.tmp && mv server.properties.tmp server.properties"  //This removes all comments in server.properties
		]
	},
	"backup": {
		"debug": false, //Whether or not to print debug messages
		"time": "04:00", //24hr time to reset server (based on pacific time)
		"longBackupDay": 1, //What day of the month to do long backups
		"types": { //Types of backups
			"data_xz": {
				"type": "both", //Whether to do "long", "short", or "both" types of backups 
				"compression": "xz", //Compression to use, either xz, or bz2
				"threaded": true, //Whether or not to use multithreading
				"shortLimit": 7, //Limit of short backups to keep
				"longLimit": 0, //Limit of long backups to keep
				"shortFreq": 1, //Do a short backup once every x days 
				"files": "'world' 'world_nether' 'world_the_end'" //Files to backup 
			},
			"data_bz2": {
				"type": "short",
				"compression": "bz2",
				"threaded": false,
				"shortLimit": 3,
				"longLimit": 3,
				"shortFreq": 7,
				"files": "'server.properties' 'example_backup.json'"
			}
		}
	}
}


```
## Contributing

Pull requests are welcome. For major changes, please open an issue first
to discuss what you would like to change.

## License

[GPLv3](https://choosealicense.com/licenses/gpl-3.0/)
