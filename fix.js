var sys = require('sys');
var events = require('events');
var tcp = require('net');

//static vars
const SOHCHAR = String.fromCharCode(1);
const ENDOFTAG8=10;
const STARTOFTAG9VAL=ENDOFTAG8+2;
const SIZEOFTAG10=8;

function Server(compID){
	events.EventEmitter.call(this);
	this.clients = new Array();
	this.compID = compID;
	this.addClientSession = function(stream) { this.clients.push(stream);};
	this.removeClientSession = function(stream) { /*TODO*/;};
}


sys.inherits(Server, events.EventEmitter);

exports.createServer = function(compID, opt){

	var server = new Server(compID);

	server.socket = tcp.createServer(function(stream){

		stream.setEncoding("utf8");
		stream.setTimeout(1000);

		const fixVersion = opt.version;
		const headers = opt.headers;
		const trailers = opt.trailers;
			
		//session vars
		var senderCompID = "";
		var targetCompID = "";
		var heartbeatDuration = 0;

		var databuffer = "";
		var charlen = 0;
	
		var loggedIn = false;
		var incomingSeqNum = 1;
		var outgoingSeqNum = 1;
		var timeOfLastIncoming = 0;
		var timeOfLastOutgoing = 0;
		
		var intervalIDs = [];

		stream.addListener('connect', function(){
			server.addClientSession(stream);
		});

		stream.addListener('end', function(){
			for(var intervalID in intervalIDs){
				clearInterval(intervalIDs[intervalID]);
			}
			server.removeClientSession(stream);
			sys.log("Connection ended for "+ stream.remoteAddress+ " [Active connections: " + server.clients.length + "]");
			stream.end();
		});

		stream.addListener("data", function (data) {

		//Add data to the buffer (to avoid processing fragmented TCP packets)		
		databuffer += data;
		timeOfLastIncoming = new Date().getTime();
		
		while(true){

			//====Step 1: Extract complete FIX message====

			//If we don't have enough data to start extracting body length, wait for more data
			if(databuffer.length <= ENDOFTAG8){ return; }

			var _idxOfEndOfTag9Str = databuffer.substring(ENDOFTAG8).indexOf(SOHCHAR);
			var idxOfEndOfTag9 = parseInt(_idxOfEndOfTag9Str,10) + ENDOFTAG8 ;
			
			if(isNaN(idxOfEndOfTag9)){
				sys.log("[ERROR] Unable to find the location of the end of tag 9. Message probably misformed");
				stream.end();
			}
			

			//If we don't have enough data to stop extracting body length AND we have received a lot of data
			//then perhaps there is a problem with how the message is formatted and the session should be killed
			if(idxOfEndOfTag9 < 0 && databuffer.length > 100){
				sys.log("[ERROR] Over 100 character received but body length still not extractable.  Message probably misformed.");
				stream.end();
			}

	
			//If we don't have enough data to stop extracting body length, wait for more data	
			if(idxOfEndOfTag9 < 0){ return; }

			var _bodyLengthStr = databuffer.substring(STARTOFTAG9VAL,idxOfEndOfTag9);
			var bodyLength = parseInt(_bodyLengthStr,10);			
			if(isNaN(bodyLength)){
				sys.log("[ERROR] Unable to parse bodyLength field. Message probably misformed");
				stream.end();
			}
			
			var msgLength = bodyLength + idxOfEndOfTag9 + SIZEOFTAG10;

			//If we don't have enough data for the whole message, wait for more data
			if(databuffer.length < msgLength){ return; }

			var msg = databuffer.substring(0, msgLength);
			databuffer = databuffer.substring(msgLength);

			sys.log("FIX in: "+msg);

			//====Step 2: Validate message====
			if(msg.substr(-1 * (SIZEOFTAG10-1),3)!="10="){
				sys.log("[WARNING] Discarding message because according to body length, checksum is not at expected location: "+msg);
				continue;
			}
			
			//====Step 3: Convert to map====
			var keyvals = msg.split(SOHCHAR);
			//sys.debug("keyvals:"+keyvals);
			var fix = {};
			for(kv in keyvals){
				//sys.debug("kv:"+kv);
				var kvpair = keyvals[kv].split("=");
				fix[kvpair[0]] = kvpair[1];
			}
			
			//var dbg = "{";
			//for( var x in fix){ dbg += ","+x+":"+fix[x]+"";}
			//sys.debug(dbg+"}");
			
			//====Step 4: Confirm all required fields are available====
			for(var f in headers){
				var tag = headers[f];
				if(tag.charAt(tag.length-1) != "?" && fix[tag]==null){//If tag is required, but missing
					sys.log("[ERROR] tag "+tag+" is required but missing in incoming message: "+msg);
					if(loggedIn){ send({"35":"3", "45":fix["34"], "58":"MissingTags"});/*send session reject*/}
					else{ 
						stream.end();
						return;
					}
				}
			}
			
			for(var f in trailers){
				var tag = headers[f];
				if(tag.charAt(tag.length-1) != "?" && fix[tag]==null){//If tag is required, but missing
					sys.log("[ERROR] tag "+tag+" is required but missing in incoming message: "+msg);
					if(loggedIn){send({"35":"3", "45":fix["34"], "58":"MissingTags"});/*send session reject*/}
					else{ 
						stream.end();
						return;
					}
				}
			}
			
			//====Step 5: Confirm first message is a logon message
			var msgType = fix["35"];
			if(!loggedIn && msgType != "A"){
				sys.log("[ERROR] Logon message expected, received message of type " + msgType);
				stream.end();
				return;
			}
			
			//====Step 6: Confirm incoming sequence number====
			var _seqNum = parseInt(fix["34"],10);
			if(loggedIn && _seqNum == incomingSeqNum){
				incomingSeqNum++;
			}
			else if(loggedIn && _seqNum < incomingSeqNum){
				sys.log("[ERROR] Incoming sequence number lower than expected. No way to recover.");
				stream.end();
				return;
			}
			else if(loggedIn && _seqNum > incomingSeqNum){
				//Missing messages, send resend request and don't process any more messages
				//until the resend request is processed
				//set flag saying "waiting for resend"
			}
			
			//====Step 7: Confirm compids and fix version match what was in the logon msg
			var incomingFixVersion = fix["8"];
			var incomingSenderCompID = fix["56"];
			var incomingTargetCompID = fix["49"];
			
			if(loggedIn && (fixVersion != incomingFixVersion || senderCompID != incomingSenderCompID || targetCompID != incomingTargetCompID)){
				sys.log("[WARNING] Incoming fix version ("+incomingFixVersion+"), sender compid ("+incomingSenderCompID+") or target compid ("+incomingTargetCompID+") did not match expected values ("+fixVersion+","+senderCompID+","+targetCompID+")");
				/*send session reject*/
			}

			
			//====Step 8: Messages
			switch( msgType ){
				case "0": //handle heartbeat; break;
					break;
				case "1": //handle testrequest; break;
					var testReqID = fix["112"];
					send({"35":"0", "112":testReqID});/*send heartbeat*/
					break;
				case "2": //handle resendrequest; break;
					break;
				case "3": //handle sessionreject; break;
					break;
				case "4": //handle seqreset; break;
				case "5": //handle logout; break;
					send({"35":"5"});/*send a logout ack right back*/
					break;
				case "A": //handle logon; break;
					fixVersion = fix["8"];
					senderCompID = fix["56"];
					targetCompID = fix["49"];
					heartbeatDuration = parseInt(fix["108"],10) * 1000; 
					loggedIn = true;
					var intervalID = setInterval(heartbeatCallback, heartbeatDuration);
					intervalIDs.push(intervalID);
					
					sys.log(fix["49"] +" logged on from " + stream.remoteAddress);
					
					send({"35":"A", "108":fix["108"]});/*send logon ack*/
					break;
				default: 
			}
		}
		

	});
	
	var heartbeatCallback =  function () {
		var currentTime = new Date().getTime();
		
		if(currentTime - timeOfLastOutgoing > heartbeatDuration){
			send({"35":"0"});/*send heartbeat*/
		}
		
		if(currentTime - timeOfLastIncoming > heartbeatDuration * 1.5){
			send({"35":"1", "112":outgoingSeqNum+""});/*send testrequest*/
		}
		
		if(currentTime - timeOfLastIncoming > heartbeatDuration * 3){
			sys.log("[ERROR] No message received from counterparty and no response to test request.");
			stream.end();
			return;
		}
	};
	
	var send = function(msg){

	
		delete msg["9"]; //bodylength
		delete msg["10"]; //checksum
		delete msg["52"]; //timestamp
		delete msg["8"]; //fixversion
		delete msg["56"]; //sendercompid
		delete msg["49"]; //targetcompid
		delete msg["34"]; //seqnum
		
		var headermsg = "";
		for(var f in headers){
			var tag = headers[f];
			
			if(tag == "8" || tag == "9" || tag == "59" || tag == "52" || tag == "56" || tag == "49" || tag == "34"){
				continue;
			}
			
			if(tag.charAt(tag.length-1) != "?" && msg[tag]==null){//If tag is required, but missing
				sys.log("[ERROR] tag "+tag+" is required but missing in outgoing message: "+msg);
				return;
			}

			if(msg[tag]!=null){
				headermsg += tag + "=" + msg[tag] + SOHCHAR;
				delete msg[tag];
			}
		}
		
		var timestamp = new Date();
		headermsg += "52=" + timestamp.getUTCFullYear() + timestamp.getUTCMonth() + timestamp.getUTCDay() + "-" + timestamp.getUTCHours() + ":" + timestamp.getUTCMinutes() + ":" + timestamp.getUTCSeconds() + "." + timestamp.getUTCMilliseconds() + SOHCHAR;
		headermsg += "56=" + senderCompID + SOHCHAR;
		headermsg += "49=" + targetCompID + SOHCHAR;
		headermsg += "34=" + (outgoingSeqNum++) + SOHCHAR;
		
		var trailermsg = "";
		for(var f in trailers){
			var tag = trailers[f];
			
			if(tag == "10"){ continue; }
			
			if(tag.charAt(tag.length-1) != "?" && msg[tag]==null ){//If tag is required, but missing
				sys.log("[ERROR] tag "+tag+" is required but missing in outgoing message: "+msg);
				return;
			}

			if(msg[tag]!=null){
				trailermsg += tag + "=" + msg[tag] + SOHCHAR;
				delete msg[tag];
			}
		}
		
		var bodymsg = "";
		for(var tag in msg){
			bodymsg += tag + "=" + msg[tag] + SOHCHAR;
		}
		
		var outmsg = "";
		outmsg += "8=" + fixVersion + SOHCHAR;
		outmsg += "9=" + (headermsg.length + bodymsg.length + trailermsg.length) + SOHCHAR;
		outmsg += headermsg;
		outmsg += bodymsg;
		outmsg += trailermsg;
		
		var checksum = 0;
		for(var x in outmsg){ checksum += outmsg.charCodeAt(x);}
		checksum = checksum % 256;
		
		var checksumstr = "";
		if(checksum < 10) checksumstr = "00" + checksum;
		else if(checksum >= 10 && checksum < 100) checksumstr = "0" + checksum;
		else checksumstr = "" + checksum;
		
		outmsg += "10=" + checksumstr + SOHCHAR;
		
		sys.log("FIX out:" + outmsg);
		timeOfLastOutgoing = new Date().getTime();
		stream.write(outmsg);
	};

	});
	return server;
}

Server.prototype.listen = function(port){ this.socket.listen(port); }


