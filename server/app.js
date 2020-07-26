// 1. Install dependencies
// 	npm install
// 
// 2. Set your auth token:
//  export AUTH_TOKEN=xxxxxxx
// See: https://docs.particle.io/reference/developer-tools/cli/#particle-token-create
// 
// 3. Run the program:
//	node app.js --productId 1234

var Particle = require('particle-api-js');
var particle = new Particle();

const fs = require('fs');
const path = require('path');

var sha1 = require('sha1');

const argv = require('yargs')
.usage('Usage: $0 [options] --productId=NN')
.alias('p', 'productId')
.nargs('p', 1)
.describe('p', 'product ID to monitor (required)')
.argv;

const cameraEventName = 'camera';

const productId = parseInt(argv.p);
if (isNaN(productId)) {
	console.log("--productId=NNN required");
	return 1;	
}

const token = process.env.AUTH_TOKEN;
if (!token) {
	console.log("AUTH_TOKEN must be set in the environment");
	return 1;	
}   

let stateData = {};

// Setting recursive:true avoids the exception on directory exists
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, {recursive:true});

// Monitor the product event stream for the product
particle.getEventStream({ product:productId, auth: token }).then(function(stream) {
    stream.on('event', function(event) {
        // console.log("Event: ", event);

        if (event.name === 'loc' || event.name === cameraEventName) {
            var deviceDataDir = path.join(dataDir, event.coreid);
            fs.mkdirSync(deviceDataDir, {recursive:true});   
        
            if (!stateData[event.coreid]) {
                // No state data for this device, create it
                stateData[event.coreid] = {};
            }
        
            try {
                var dataObj = JSON.parse(event.data);
        
                if (event.name === 'loc') {
                    console.log('loc: ' + JSON.stringify(dataObj));
                    // Uncomment this to save all loc events to files
                    // fs.writeFileSync(path.join(deviceDataDir, event.published_at), JSON.stringify(dataObj, null, 2));
                    stateData[event.coreid].loc = dataObj;
                }
                else {
                    // Camera event
                    cameraEvent(event, dataObj, deviceDataDir);
                }
            }
            catch(e) {
                console.log('event exception data=' + event.data, e);
            }
        }
    });
});

function cameraEvent(event, dataObj, deviceDataDir) {
    // 

    console.log('camera event size=' + event.data.length, dataObj);

    if (dataObj.op === 'start') {
        // fileNum, chunkSize, fileSize, hash[4]
        stateData[event.coreid].fileName = event.published_at + '.jpg';
        stateData[event.coreid].fileNum = dataObj.fileNum;
        stateData[event.coreid].chunkSize = dataObj.chunkSize;
        stateData[event.coreid].fileSize = dataObj.fileSize;
        stateData[event.coreid].hash = dataObj.hash;
        stateData[event.coreid].lastChunk = -1;
        stateData[event.coreid].timer = null;
        stateData[event.coreid].gotEnd = false;

        // Allocate the buffer to hold the binary image data
        stateData[event.coreid].imageData = Buffer.alloc(dataObj.fileSize);

        // Allocate an array of booleans to hold the chunk received flag
        stateData[event.coreid].numChunks = Math.ceil(dataObj.fileSize / dataObj.chunkSize);
        stateData[event.coreid].chunkReceived = [];
        for(var ii = 0; ii < stateData[event.coreid].numChunks; ii++) {
            stateData[event.coreid].chunkReceived.push(false);
        }
        // Confirm start
        var req = {};
        req.op = 'start';
        req.file = dataObj.fileNum;
        callCameraFunction(event, dataObj, req, 20000);

        // Save most recent loc event 
        if (stateData[event.coreid].loc) {
            fs.writeFileSync(path.join(deviceDataDir, event.published_at + '.json'), JSON.stringify(stateData[event.coreid].loc, null, 2));
            delete stateData[event.coreid].loc;
        }
    }
    else
    if (dataObj.op === 'chunk') {
        // fileNum, chunk, data
        if (dataObj.fileNum != stateData[event.coreid].fileNum) {
            // Wrong file, send a request to restart
            console.log('wrong fileNum=' + dataObj.fileNum + ' expected=' + stateData[event.coreid].fileNum);
            callCameraFunction(event, dataObj, {"op":"restart"}, 20000);
            return;
        }

        if (dataObj.chunk >= stateData[event.coreid].numChunks) {
            console.log('invalid chunk=' + stateData[event.coreid].numChunks + ' numChunks=' + stateData[event.coreid].numChunks);
            return;
        }

        // Convert the Base-64 data into a buffer of binary data
        var dataBuf = Buffer.from(dataObj.data, 'base64');

        // Copy into big buffer
        var chunkOffset = dataObj.chunk * stateData[event.coreid].chunkSize;
        dataBuf.copy(stateData[event.coreid].imageData, chunkOffset);
        stateData[event.coreid].chunkReceived[dataObj.chunk] = true;

        stateData[event.coreid].lastChunk = dataObj.chunk;
        stateData[event.coreid].chunkReceived[dataObj.chunk] = true;

        if (stateData[event.coreid].timer != null) {
            clearTimeout(stateData[event.coreid].timer);
            stateData[event.coreid].timer = null;
        }

        // Do we have all parts? 
        var haveAll = true;
        for(var ii = 0; ii < stateData[event.coreid].numChunks; ii++) {
            if (!stateData[event.coreid].chunkReceived[ii]) {
                // Missing
                haveAll = false;
                break;
            }
        }

        if (!haveAll) {
            // Start a timer to request missing chunk. Most of the time
            // we'll get a chunk before this occurs and reset the timer.
            stateData[event.coreid].timer = setTimeout(function() {
                console.log('requesting missing chunks from timer');
                requestResend(event, dataObj);
            }, 20000);

            return;
        }

        // We have all parts!

        const hash = sha1(stateData[event.coreid].imageData);
        if (stateData[event.coreid].hash != hash) {
            console.log('hash mismatch expected=' + stateData[event.coreid].hash + ' got=' + hash);

            // Wait 30 seconds and send a restart event to retransmit the file
            setTimeout(function() {
                console.log("sending restart request");

                var req = {};
                req.op = 'restart';
                req.file = dataObj.fileNum;
                callCameraFunction(event, dataObj, req, 20000);    
            }, 30000);

            return;
        }
        
        // We have all chunks for this file. Save now.
        fs.writeFileSync(path.join(deviceDataDir, stateData[event.coreid].fileName), stateData[event.coreid].imageData);

        // Send the done event
        var req = {};
        req.op = 'done';
        req.file = dataObj.fileNum;
        callCameraFunction(event, dataObj, req, 20000);

    }
}

function requestResend(event, dataObj) {
    var req = {};
    req.op = 'resend';
    req.file = dataObj.fileNum;
    req.chunks = [];

    for(var ii = 0; ii < stateData[event.coreid].numChunks; ii++) {
        if (!stateData[event.coreid].chunkReceived[ii]) {
            // Missing
            req.chunks.push(ii);
        }
    }

    callCameraFunction(event, dataObj, req, 20000);
}

function callCameraFunction(event, dataObj, req, retryTime) {
    if (!retryTime) {
        // Default is 20 seconds
        retryTime = 20000;
    }

    console.log('requesting', req);

    particle.callFunction({deviceId:event.coreid, name:'camera', argument:JSON.stringify(req), product:productId, auth:token }).then(
        function(data) {
            console.log('function called successfully', data);
        },
        function (err) {
            console.log('function call error', err);
            setTimeout(function() {

                callCameraFunction(event, dataObj, req, retryTime);
            }, 20000);
        }
    );
 
}
