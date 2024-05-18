//Definitions

const fs = require('fs');
const { execSync } = require('child_process');
const os = require('os');
const path = require('path');
const configFile = path.resolve(process.argv[2]);
const config = JSON.parse(fs.readFileSync(configFile).toString());
const username = os.userInfo().username;
const sshCommand = `ssh ${config.connection.username}@${config.connection.ip}`;
const logFile = {
	control : `${config.server.name}_control.log`,
	server : `${config.server.name}_config.server.log`,
}

const homeDirectory = os.homedir();
const knownHostsFile = `${homeDirectory}/.ssh/known_hosts`;
let ctrlc_ing = false;
let startTime;
let timerRunning = false;

//Lib

function log(...args) {
	let message;
	if (!config.backup.debug) {
    	message = "[" + getPacificDateTime() + "] " + args.join(" ");
	} else {
    	message = "[" + getPacificDateTime() + "] " + args.join(" ").replaceAll(config.connection.password,"[PASSWORD]").replaceAll(config.connection.ip,"[IP]").replaceAll(config.connection.username,"[USERNAME]");		
	}
    console.log(message);
    fs.appendFileSync(logFile.control, message + "\n");
}

function toggleTimer() {
    if (timerRunning) {
        const endTime = new Date();
        const duration = endTime - startTime;
        const formattedDuration = formatTime(duration);
		timerRunning = false;
        return(formattedDuration);
    } else {
        startTime = new Date();
        timerRunning = true;
    }
}

function formatTime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000) % 60;
    const minutes = Math.floor(milliseconds / (1000 * 60)) % 60;
    const hours = Math.floor(milliseconds / (1000 * 60 * 60)) % 24;
    const ms = milliseconds % 1000;

    const formattedHours = hours < 10 ? "0" + hours : hours;
    const formattedMinutes = minutes < 10 ? "0" + minutes : minutes;
    const formattedSeconds = seconds < 10 ? "0" + seconds : seconds;
    const formattedMs = ms < 10 ? "00" + ms : (ms < 100 ? "0" + ms : ms);

    return `${formattedHours}:${formattedMinutes}:${formattedSeconds}.${formattedMs}`;
}

function isDayOfMonth(day) {
    const currentDateUTC = new Date();
    const currentDateTimezoneOffset = currentDateUTC.getTimezoneOffset();
    const losAngelesTimezoneOffset = 480;
    const currentDateLosAngeles = new Date(currentDateUTC.getTime() + (currentDateTimezoneOffset - losAngelesTimezoneOffset) * 60000);
    return currentDateLosAngeles.getDate() === day;
}

function getPacificDateTime() {
	const date = new Date();
	const pacificDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
	const formattedDate = pacificDate.toISOString().split('T')[0];
	const formattedTime = pacificDate.toTimeString().split(' ')[0];
	return `${formattedDate}_${formattedTime}`;
}

function getPacificTime() {
    const date = new Date();
    const pacificDate = new Date(date.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
    const hours = pacificDate.getHours().toString().padStart(2, '0');
    const minutes = pacificDate.getMinutes().toString().padStart(2, '0');
    return `${hours}:${minutes}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function graceful_shutdown(){
	if (!ctrlc_ing) {
		ctrlc_ing = true;
		log('Ctrl+C pressed, cleaning up...');
		server_command(config.server.command.stop);
		await sleep(10000);
		if (server_is_running()) server_shell(`screen -S "${config.server.name}_server" -X quit`);
		process.exit(0);
	}
}

function getTimeDifference(timeStr1, timeStr2) {
    const [hours1, mins1] = timeStr1.split(':').map(Number);
    const [hours2, mins2] = timeStr2.split(':').map(Number);
    const totalMins1 = hours1 * 60 + mins1;
    const totalMins2 = hours2 * 60 + mins2;
    let diffMins = totalMins1 - totalMins2;
    if (diffMins < 0) diffMins += 24 * 60;
    const diffHours = Math.floor(diffMins / 60);
    const remainingMins = diffMins % 60;
    return `${String(diffHours).padStart(2, '0')}:${String(remainingMins).padStart(2, '0')}`;
}

function getDaysSinceUnixEpoch() {
    const currentDateMilliseconds = Date.now();
    const daysSinceUnixEpoch = Math.floor(currentDateMilliseconds / (1000 * 60 * 60 * 24));
    return daysSinceUnixEpoch;
}

function md5sum(file){
	return(server_shell(`md5sum ${file} | awk '{print $1}'`));
}

process.on('SIGINT', async () => {
	graceful_shutdown();
});

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
██████████████▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒██████████████ \x1b[32m   ▐            ▐       ▐                   ▐ \x1b[37m  v1.1 \x1b[35m 
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

function server_shell(command,removeNewLines=true){
	try {
		if (config.backup.debug) log('\x1b[90m'+command+'\x1b[37m');
		let output = execSync(command).toString();
		if (removeNewLines) output = output.replaceAll("\n","");
		return(output);
	} catch(e) {
		//Pass ctrl+c from child process to main
		if (e.signal=='SIGINT') {
			graceful_shutdown();
			return(false);
		}
		return(false);
	}
}

function server_start(){
	log(`Starting server for ${config.server.type} - ${config.server.name}`);
	server_shell(`rm -rf "${config.server.name}_server.log"`);
	server_shell(`screen -L -Logfile "${config.server.name}_server.log" -dmS "${config.server.name}_server" ${config.server.command.start}`);
	server_shell(`screen -S "${config.server.name}_server" -X detach`);
}

function server_command(command){
	server_shell(`screen -S "${config.server.name}_server" -p 0 -X stuff "${command}^M"`);
}

function server_warn(warning){
	log(warning);
	server_command(`${config.server.command.say} ${warning}`);
}

function server_is_running(){
	return(!!server_shell(`screen -list | grep "\\.${config.server.name}_server"`));
}

async function server_backup(){
	log(`Backing up ${config.server.type} - ${config.server.name}`);
	
	//Stop server
	if (config.server.runs && config.server.restartOnBackup) {
		log("Stopping server")
		server_command(config.server.command.stop);
		await sleep(10000);
		if (server_is_running()) server_shell(`screen -S "${config.server.name}_server" -X quit`);
	}

	//Run prerun commands
	if (config.server.prerun.length>0){
		log(`Running ${config.server.prerun.length} prerun commands`);
		for (var x=0; x<config.server.prerun.length; x++){
			let command = config.server.prerun[x];
			server_shell(command);
		}
	}

	let daysSinceUnixEpoch = getDaysSinceUnixEpoch()

	//Create backups
	let dateTime = getPacificDateTime();
	let workingFiles={};
	for (backupName in config.backup.types){
		let backup = config.backup.types[backupName];
		let fileName = `${config.server.name}_${backupName}_${dateTime}.tar.${backup.compression}`;
		let doBackup, backupType;
		
		if ( (backup.type == "long" || backup.type == "both") && (isDayOfMonth(config.backup.longBackupDay) || remote_folder_count(backupName+"/long") == 0)) {
			doBackup = true;
			backupType = "long";
		} else if ((daysSinceUnixEpoch % backup.shortFreq == 0 || remote_folder_count(backupName+"/short") == 0) && backupType != "long") {
			doBackup = true;
			backupType = "short";
			//Check if we need to store a long term backup because we don't have any
			if (backup.type == "both"){
				let count = remote_folder_count(backupName+"/long");
				if (count == 0) backupType = "long";
			}
		}

		if (doBackup) {
			log(`Creating temporary folder ${backupName}`);
			toggleTimer();
			server_shell(`mkdir -p temp_${backupName}`);
			server_shell(`cp -r ${backup.files} "temp_${backupName}"  > /dev/null 2>&1`);
			workingFiles[backupName] = backup;
			workingFiles[backupName].fileName = fileName;
			workingFiles[backupName].originalType = workingFiles[backupName].type;
			workingFiles[backupName].type = backupType;
			let timeEnd = toggleTimer();
			log(`Completed copy for ${backupName} in ${timeEnd}`);
		}
	}
	
	//Start server back up
	if (config.server.runs && config.server.restartOnBackup) {
		server_start();
	}

	for(backupName in workingFiles){
		let backup = workingFiles[backupName];
		log(`Creating backup ${backupName} - compression: ${backup.compression} threaded: ${backup.threaded}`);
		toggleTimer();

		if (backup.compression == "bz2"){
			if (backup.threaded) {
				server_shell(`find temp_${backupName} -printf "%P\n" | tar cmf "./${backup.fileName}" --no-recursion -C temp_${backupName} -T - --mtime="1970-04-20 00:00:00" --use-compress-program=lbzip2 > /dev/null 2>&1`)
			} else {
				server_shell(`find temp_${backupName} -printf "%P\n" | tar cjmf "./${backup.fileName}" --no-recursion -C temp_${backupName} -T - --mtime="1970-04-20 00:00:00" > /dev/null 2>&1`)
			}
		} else {
			if (backup.threaded) {
				server_shell(`find temp_${backupName} -printf "%P\n" | tar -Ipixz -cmf "./${backup.fileName}" --no-recursion -C temp_${backupName} -T - --mtime="1970-04-20 00:00:00" > /dev/null 2>&1`)
			} else {
				server_shell(`find temp_${backupName} -printf "%P\n" | tar -cJmf "./${backup.fileName}" --no-recursion -C temp_${backupName} -T - --mtime="1970-04-20 00:00:00" > /dev/null 2>&1`)			
			}
		}
	
		let timeEnd = toggleTimer();
		log(`Completed compression for ${backupName} in ${timeEnd}`);

		backup.size = parseInt(server_shell(`stat -c '%s' "${backup.fileName}"`));

		let folderName = backupName+"/"+backup.type;
		let latestSize = remote_latest_size(folderName);
		let doBackup = true;
		let md5;
		if (latestSize == backup.size) {
			md5 = md5sum(backup.fileName);
			let remoteMd5 = remote_latest_md5sum(folderName);
			if (md5 == remoteMd5){
				doBackup = false;
			}
		}

		if (doBackup) {
			remote_upload(folderName,backup.fileName);
			let limit;
			if (backup.type == "long") {
				limit = backup.shortLimit;
			} else {
				limit = backup.longLimit;
			}
			if (limit != 0) remote_delete_old(folderName,limit);

			//Copy long to short if its ready for a short them backup
			if (backup.type == "long" && backup.originalType == "both" && daysSinceUnixEpoch % backup.shortFreq == 0) {
				let shortFolderName = backupName+"/short";
				let shortLatestSize = remote_latest_size(shortFolderName);
				let shortDoBackup = true;
				if (shortLatestSize == backup.size){
					if (md5==null) md5 = md5sum(backup.fileName);
					let shortRemoteMd5 = remote_latest_md5sum(folderName);
					if (md5 == shortRemoteMd5){
						shortDoBackup = false;
					}
				}
				if(shortDoBackup) {
					let shortLimit = backup.shortLimit;
					remote_copy(folderName,shortFolderName,backup.fileName);
					if (shortLimit != 0) remote_delete_old(shortFolderName, shortLimit);
				}else{
					log(`Did not copy to short for ${folderName} archive content unchanged.`)
				}
			}
		} else {
			log(`Did not upload to ${folderName} archive content unchanged.`)
		}
	}


	//Delete archives
	for (let backupName in workingFiles){
		log(`Deleting temporary folder ${backupName}`);
		server_shell(`rm -rf temp_${backupName}`);
		log(`Deleting archive ${backupName}`);
		server_shell(`rm -rf ${workingFiles[backupName].fileName}`);
	}

	log("Backup complete!");
}

//Remote 

function remote_upload(folder,file){
	log(`Uploading ${file} to ${folder}`);
	toggleTimer();
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder}"`)
	server_shell(`rsync -z --compress-level=9 "./${file}" "${config.connection.username}@${config.connection.ip}:/home/${config.connection.username}/servers/${config.server.type}/${config.server.name}/${folder}/"`);
	let timeEnd = toggleTimer();
	log(`Upload for ${file} to ${folder} completed in ${timeEnd}`);
}

function remote_copy(folder_from,folder_to,file){
	log(`Copying ${file} from ${folder_from} to ${folder_to}`);
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder_to}"`)
	server_shell(`${sshCommand} cp "servers/${config.server.type}/${config.server.name}/${folder_from}/${file}" "servers/${config.server.type}/${config.server.name}/${folder_to}/"`);
}

function remote_delete(folder,file){
	log(`Deleting ${folder} ${file}`);
	server_shell(`${sshCommand} rm -rf "servers/${config.server.type}/${config.server.name}/${folder}/${file}"`)
}

function remote_size(folder,file){
	let size = parseInt(server_shell(`${sshCommand} stat -c '%s' "servers/${config.server.type}/${config.server.name}/${folder}/${file}"`));
	if (isNaN(size)) size = 0;
	return(size);
}

function remote_md5sum(folder,file){
	let md5 = server_shell(`${sshCommand} md5sum "servers/${config.server.type}/${config.server.name}/${folder}/${file}" | awk '{print $1}'`);
	if (md5==false) md5="";	
	return(md5);
}

function remote_oldest(folder){
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder}"`)
	return(server_shell(`${sshCommand} "ls -lt servers/${config.server.type}/${config.server.name}/${folder}/*.tar.{bz2,xz}" 2>/dev/null | grep "^-rw" | awk '{print $NF}' | tail -n 1 | xargs basename 2>/dev/null`));
}

function remote_list_oldest(folder){
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder}"`)
	return(server_shell(`${sshCommand} "ls -ltr servers/${config.server.type}/${config.server.name}/${folder}/*.tar.{bz2,xz}" 2>/dev/null | grep "^-rw" | awk '{print $NF}' | xargs -n 1 basename 2>/dev/null`,false));
}

function remote_newest(folder){
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder}"`)
	return(server_shell(`${sshCommand} "ls -lt servers/${config.server.type}/${config.server.name}/${folder}/*.tar.{bz2,xz}" 2>/dev/null | grep "^-rw" | awk '{print $NF}' | head -n 1 | xargs basename 2>/dev/null`));
}

function remote_list_newest(folder){
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder}"`)
	return(server_shell(`${sshCommand} "ls -lt servers/${config.server.type}/${config.server.name}/${folder}/*.tar.{bz2,xz}" 2>/dev/null | grep "^-rw" | awk '{print $NF}' | xargs -n 1 basename 2>/dev/null`,false));
}	

function remote_folder_count(folder){
	server_shell(`${sshCommand} "mkdir -p servers/${config.server.type}/${config.server.name}/${folder}"`)
	return(parseInt(server_shell(`${sshCommand} "ls -lt servers/${config.server.type}/${config.server.name}/${folder}/*.tar.{bz2,xz}" 2>/dev/null | grep "^-rw" | wc -l`)));	
}

function remote_latest_size(folder){
	let newest_file = remote_newest(folder);
	if (newest_file == false) return(0);
	return(remote_size(folder,newest_file));
}

function remote_latest_md5sum(folder){
	let newest_file = remote_newest(folder);
	if (newest_file == false) return("");
	return(remote_md5sum(folder,newest_file));
}

function remote_latest_copy(folder_from,folder_to){
	let newest_file = remote_newest(folder_from);
	remote_copy(folder_from, folder_to, newest_file);
}

function remote_delete_old(folder,max){
	let existing_backup_count = remote_folder_count(folder);
	if (existing_backup_count > max) {
		let difference = existing_backup_count - max;
		log(`${difference} files over in ${folder} limit: ${max}`);
		let files = remote_list_oldest(folder).split("\n");
		for (var x=0; x<difference; x++){
			remote_delete(folder,files[x]);
		}
	}
}


async function start(){

	print_swag();

	//Delete old logs 
	server_shell(`rm -rf ${logFile.control}`);
	server_shell(`rm -rf ${logFile.server}`);
	
	//Create SSH folder
	server_shell('mkdir -p ~/.ssh');
	
	//Check known hosts
	if (!fs.existsSync(knownHostsFile)) server_shell(`touch ${knownHostsFile}`);
	
	//Add to known hosts if needed
	let remoteSSHPublicKey = server_shell(`ssh-keyscan ${config.connection.ip} 2>/dev/null`,false);
	let keyCheck = server_shell(`grep "${remoteSSHPublicKey}" ${knownHostsFile}`);
	if (!keyCheck) {
		log("Added remote to known hosts");
		server_shell(`echo "${remoteSSHPublicKey}" >> "${knownHostsFile}"`);
	}

	//Add SSH keys to remote
	if (!fs.existsSync(`${homeDirectory}/.ssh/id_rsa`)) {
		log("Generating SSH key");
		server_shell(`ssh-keygen -t rsa -b 4096 -N "" -C "${username}@hardcoreanarchy.gay" -f ${homeDirectory}/.ssh/id_rsa 2>/dev/null`);
	}
	server_shell(`sshpass -p '${config.connection.password}' ssh-copy-id -i ${homeDirectory}/.ssh/id_rsa.pub ${config.connection.username}@${config.connection.ip} 2>/dev/null`);

	log("Connected to storage server");

	//If we have something that runs
	if (config.server.runs) {
		server_start();
	}

	//1 minute check interval
	setInterval(() => {
		let currentTime = getPacificTime();
		let timeDifference = getTimeDifference(config.backup.time,currentTime);

		if (config.server.runs) {
			if (config.server.crashDetection && !server_is_running()) {
				log("Crash detected, restarting server");
				server_start();
			} else {
				if (config.server.warnBackup){
					switch(timeDifference){
						case "01:00":
							server_warn("1 hour to server restart.")
						break;
						case "00:30":
							server_warn("30 minutes to server restart.")
						break;
						case "00:15":
							server_warn("15 minutes to server restart.")
						break;
						case "00:10":
							server_warn("10 minutes to server restart.")
						break;
						case "00:05":
							server_warn("5 minutes to server restart.")
						break;
						case "00:01":
							server_warn("1 minute to server restart.")
						break;
						case "00:00":
							server_warn("Server restarting...")
						break;
					}
				}
			}
		}

		if (timeDifference == "00:00") {
			server_backup();
		}

	}, 1000 * 60); // Run every minute

}


start();
