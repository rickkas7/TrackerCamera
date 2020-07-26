/*
 * Copyright (c) 2020 Particle Industries, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "Particle.h"

#include "tracker_config.h"
#include "tracker.h"

#include "CameraHelperRK.h"


SYSTEM_THREAD(ENABLED);
SYSTEM_MODE(SEMI_AUTOMATIC);

PRODUCT_ID(TRACKER_PRODUCT_ID);
PRODUCT_VERSION(TRACKER_PRODUCT_VERSION);

SerialLogHandler logHandler(115200, LOG_LEVEL_INFO, {
    { "app.gps.nmea", LOG_LEVEL_INFO },
    { "app.gps.ubx",  LOG_LEVEL_INFO },
    { "ncp.at", LOG_LEVEL_INFO },
    { "net.ppp.client", LOG_LEVEL_INFO },
    { "app.cam", LOG_LEVEL_TRACE },
});

int takePictureHandler(String cmd);

CameraHelperTracker cameraHelper(Serial1, 115200);


void setup()
{
    Tracker::instance().init();

    Particle.function("takePicture", takePictureHandler);

    // Enable cloud configuration of settings    
    // cameraHelper.setupCloudConfig();

    // Start the camera interface
    // The CameraHelperTracker turns on the CAN_PWR to power the camera.
    cameraHelper.setup();

    Particle.connect();
}

void loop()
{
    Tracker::instance().loop();

    cameraHelper.loop();
}

int takePictureHandler(String cmd) 
{
    // Take a picture
    cameraHelper.takePicture();

    // Send the current location
    TrackerLocation::instance().triggerLocPub();
    return 0;
}

