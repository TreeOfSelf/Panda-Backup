<p align="center">
  <img src="https://sebastiancodes.online/github/pandabackup.png">
</p>

# Panda Backup

Panda Backu is a tool for originally intended to allow my Minecraft servers to have an automated backup that wasn't dependant on the server software running. It has evolved into something much greater, and can be used to customize different types of backups for any type of server, preform automated restarts, run pre-run commands (in my case, I prune chunks in Minecraft at server restart), and more!

## Prerequisites

- Node.js
- An rsync capable backup server
- lbzip2 (chosen for it's balance between small compression size and speed)
  
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
	"connection": {
		// Put the information to connect to your storage server here
	},
	"server": {
		"type": "minecraft",  // The type of server
		"name": "skyblock",  // The name of the server 
		"runs": true, //Whether or not this server "runs" (for example, a website that is on autobackup does not run if its just an html folder)
		"warnBackup": true, //Whether to announce warnings (1hr, 30m, 15m..etc) before restarting/backing u p
		"crashDetection": true, //Whether to enable crash detection 
		"restartOnBackup": true, //Whether to restart the server on backup 
		"command": {
			"start": "java -jar server.jar nogui", //The comand that launches the server
			"stop": "stop", //What the stop command is for the server 
			"say": "say" //The say command for the server 
		},
		"prerun": [  //Commands ran before archiving the backup 
			//These for example will prune chunks 
			"java -jar /usr/local/bin/mcaselector.jar --mode delete --world 'world' --query 'InhabitedTime < 1min'",  
			"java -jar /usr/local/bin/mcaselector.jar --mode delete --world 'world_nether' --region 'world_nether/DIM-1/region' --query 'InhabitedTime < 1min'",
			"java -jar /usr/local/bin/mcaselector.jar --mode delete --world 'world_the_end' --region 'world_the_end/DIM1/region' --query 'InhabitedTime < 1min'",
			//This removes all the comments on the server.properties file so that the archive hash isn't affected by them 
			"grep -v '^#' server.properties > server.properties.tmp && mv server.properties.tmp server.properties"
		]
	},
	//Backup configurations
	"backup": {
		//Enable/disable debug messages 
		"debug": false,
		//24hr time of backup (based on Pacific time)
		"time": "18:50",
		//The day long backups are done on (should be the 1st)
		"longBackupDay": 16,
		"types": {
			//Backup name 
			"data": {
				//Whether this does "long" (once a month) "short" (per shortFreq days) or "both" backups 
				"type": "both",
				//Number of short backups to keep back 
				"shortLimit": 3,
				//Number of long backups to keep back 
				"longLimit": 3,
				//How oftem, every 1 days, every 3 days..etc to do short backups 
				"shortFreq": 1,
				//The files/folders to backup 
				"files": "'world' 'world_nether' 'world_the_end'"
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
