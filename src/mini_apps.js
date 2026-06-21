/**
 * mini_apps.js
 *
 * This file handles the dynamic loading and initialization of mini applications and chat extensions
 * within the main application. It retrieves the manifest files for each mini app, processes the
 * manifest data, and creates corresponding UI elements such as buttons. These buttons allow users
 * to launch the mini apps  and chat extensions from the mini app menu.
 *
 */

"use strict";

if (!window.miniApps) {
    window.miniApps = {}; // Ensure it's defined
}

let miniAppDirectory = "../miniApps/"; // Default directory for mini apps

/**
 * Handles the paths to manifest files.
 *
 * This function gets the paths to the manifest files of every app from the backend as input and
 * forwards each path to the backend to retrieve the data of each manifest file.
 *
 * @param {string} manifestPathsJson - JSON string containing an array of paths to manifest files.
 */
function handleManifestPaths(manifestPathsJson) {

    const manifestPaths = JSON.parse(manifestPathsJson);
    const listElement = document.getElementById('lst:miniapps');

    manifestPaths.forEach(path => {
        backend("getManifestData " + path);
        //fetchManifestFile(path);
    });

}

initializeMiniApps();

function initializeMiniApps() {
    console.log("Initializing Mini Apps using local directory listing");

    const miniAppsUrl = "../miniApps/";

    fetch(miniAppsUrl)
        .then(response => response.text())
        .then(htmlText => {
            console.log("Directory listing HTML:", htmlText);

            // Use regex to extract folder names from addRow calls.
            // This regex captures the first string argument of addRow, e.g., "kanban" in addRow("kanban", "kanban", 1, ...)
            const regex = /addRow\("([^"]+)"\s*,\s*"([^"]+)"\s*,/g;
            const folderNames = [];
            let match;
            while ((match = regex.exec(htmlText)) !== null) {
                const folderName = match[1];
                // Exclude "." or ".." if present.
                if (folderName !== "." && folderName !== "..") {
                    folderNames.push(folderName);
                }
            }

            console.log("Extracted mini app folders:", folderNames);

            // For each extracted folder name, fetch its manifest.json
            folderNames.forEach(folder => {
                const manifestPath = `${miniAppsUrl}${folder}/manifest.json`;
                fetch(manifestPath)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error(`HTTP error: ${response.status}`);
                        }
                        return response.text();
                    })
                    .then(manifestText => {
                        handleManifestContent(manifestText);
                    })
                    .catch(error => {
                        console.error(`Error loading manifest for folder ${folder}:`, error);
                    });
            });
        })
        .catch(error => {
            console.error("Error fetching miniApps directory listing:", error);
        });
}




/**
 * Handles the content of a manifest file.
 *
 * This function gets the data of a manifest file, creates a button containing that data and appends
 * that button to the list that contains all the buttons that initiate each mini app.
 *
 * @param {string} content - JSON string containing the manifest data.
 */
function handleManifestContent(content) {
    setTimeout(() => {
        const manifest = JSON.parse(content);
        let miniAppPath = "../miniApps/" + manifest.id + "/";

        // Load and inject CSS file
        if (manifest.cssFile) {
            const cssFilePath = miniAppPath + manifest.cssFile;
            fetch(cssFilePath)
                .then(response => response.text())
                .then(cssContent => {
                    const styleEl = document.createElement('style');
                    styleEl.innerText = cssContent;
                    document.head.appendChild(styleEl);
                    console.log("CSS content added to document head:", cssFilePath);
                })
                .catch(error => console.error("Error loading CSS:", error));
        }

        // Load and inject HTML file
        let htmlFile = miniAppPath + manifest.htmlFile;
        fetch(htmlFile)
            .then(response => response.text())
            .then(text => {
                (function () {
                    var coreDiv = document.getElementById('core');
                    if (coreDiv) {
                        coreDiv.insertAdjacentHTML("beforeend", text);
                        console.log("HTML content added to core div");
                    } else {
                        console.log("Core div not found");
                    }
                })();
            })
            .catch(error => console.error("Error loading HTML:", error));
        
        // Load and inject JS files from the "scripts" array
        const scripts = manifest.scripts || [];
        scripts.forEach(scriptPath => {
            let fullScriptPath = miniAppPath + scriptPath;
            fetch(fullScriptPath)
                .then(response => response.text())
                .then(scriptContent => {
                    const scriptEl = document.createElement('script');
                    scriptEl.text = scriptContent;
                    document.body.appendChild(scriptEl);
                    console.log("JS file loaded and executed:", fullScriptPath);
                })
                .catch(error => console.error("Error loading JS:", error));
        });

        // Process the manifest data (e.g., create buttons)
        const listElement = document.getElementById("lst:miniapps");
        const miniAppButton = createMiniAppButton(manifest);
        listElement.appendChild(miniAppButton);

        // Extract scenarios from manifest
        const scenarioData = manifest.scenario || {};

        // Create the displayOrNot list by using each scenario key (assuming the container is "div:" + key)
        const displayOrNotList = Object.keys(scenarioData).map(key => 'div:' + key);
        console.log("displayOrNotList:", displayOrNotList);

        // Prepare maps for scenario display and scenario menu
        const scenarioDisplayMap = {};
        const scenarioMenu = {};

        Object.keys(scenarioData).forEach(key => {
            const entry = scenarioData[key];

            // For scenario display, extract and convert the display array to a list of strings
            const displayArray = entry.display || [];
            scenarioDisplayMap[key] = displayArray.map(item => String(item));

            // For scenario menu, convert the menu object to an array of key-value pairs
            const menuObj = entry.menu || {};
            const menuList = [];
            Object.keys(menuObj).forEach(menuKey => {
                menuList.push([menuKey, String(menuObj[menuKey])]);
            });
            scenarioMenu[key] = menuList;
        });

        console.log("Scenario Display Map:", scenarioDisplayMap);
        console.log("Scenario Menu:", scenarioMenu);

        // Execute JavaScript in the WebView
        injectDisplayorNot(displayOrNotList);
        injectScenarioDisplay(scenarioDisplayMap);
        injectScenarioMenu(scenarioMenu);

        console.log(`Added button after delay: ${miniAppButton.id}`);
    }, 100);
}


function injectScenarioDisplay(scenarioDisplayUpdate) {
    if (!window.scenarioDisplay) {
        console.error("scenarioDisplay is not defined in the global scope.");
        return;
    }

    Object.entries(scenarioDisplayUpdate).forEach(([key, values]) => {
        if (window.scenarioDisplay[key]) {
            // Append new elements without duplicating
            values.forEach(value => {
                if (!window.scenarioDisplay[key].includes(value)) {
                    window.scenarioDisplay[key].push(value);
                }
            });
        } else {
            // If key doesn't exist, add it
            window.scenarioDisplay[key] = [...values];
        }
    });

    console.log("Updated scenarioDisplay:", window.scenarioDisplay);
}



function injectScenarioMenu(scenarioMenuUpdate) {
    if (!window.scenarioMenu) {
        console.error("scenarioMenu is not defined in the global scope.");
        return;
    }

    Object.entries(scenarioMenuUpdate).forEach(([key, values]) => {
        if (!window.scenarioMenu[key]) {
            window.scenarioMenu[key] = [];
        }

        values.forEach(([name, func]) => {
            let existingEntry = window.scenarioMenu[key].find(entry => entry[0] === name);
            if (!existingEntry) {
                window.scenarioMenu[key].push([name, func]); // Append new entries
            }
        });
    });

    console.log("Updated scenarioMenu:", window.scenarioMenu);
}

function injectDisplayorNot(displayOrNotUpdate) {
    if (!window.display_or_not) {
        console.error("display_or_not is not defined in the global scope.");
        return;
    }

    displayOrNotUpdate.forEach(item => {
        if (!window.display_or_not.includes(item)) {
            window.display_or_not.push(item); // Append only if not already present
        }
    });

    console.log("Updated display_or_not:", window.display_or_not);
}



/**
 * Creates a button to initiate a Mini App.
 *
 * This function gets the manifest data as input and uses it to create the button that initiates
 * the mini app in the mini app menu. If the mini app is also a chat extension, a button will
 * be added in the attach-menu.
 *
 * @param {Object} manifest - The manifest data of the mini app.
 * @param {string} manifest.id - The ID of the mini app.
 * @param {string} manifest.icon - The path to the icon of the mini app.
 * @param {string} manifest.name - The name of the mini app.
 * @param {string} manifest.description - The description of the mini app.
 * @param {string} manifest.init - The initialization function as a string.
 * @param {string} [manifest.extension] - Indicates if the app is also a chat extension.
 * @returns {HTMLElement} The created button element.
 */
function createMiniAppButton(manifest) {
    const item = document.createElement('div');
    item.className = 'miniapp_item_div';

    const button = document.createElement('button');
    button.id = 'btn:' + manifest.id;
    button.className = 'miniapp_item_button w100';
    button.style.display = 'flex';
    button.style.alignItems = 'center';
    button.style.padding = '10px';
    button.style.border = '1px solid #ccc';
    button.style.borderRadius = '5px';
    button.style.backgroundColor = '#f9f9f9';

    console.log("Init function: " + manifest.init);

    //button.onclick = manifest.init();     // This didn't work as intended
    button.addEventListener('click', () => {
        try {

            if (!manifest.scripts) {
                console.log("No scripts found in manifest");
                return;
            }
            // Dynamically evaluate the init function
            console.log("Init function: " + manifest.init);
            //Set currentMiniAppID to the manifest.id
            currentMiniAppID = manifest.id
            miniAppDirectory = "../miniApps/" + manifest.id + "/";
            console.log("Mini App Directory: " + miniAppDirectory);
            setScenario("customApp:" + manifest.id);
            console.log(curr_scenario);
            eval(manifest.init);
        } catch (error) {
            console.error(`Error executing init function: ${manifest.init}`, error + " " + error.stack);
        }
    });

    const icon = document.createElement('img');
    console.log("App Icon: " + manifest.icon);
    icon.src = manifest.icon;
    icon.src = "../" + "miniApps/" + manifest.id + "/" + manifest.icon;
    icon.alt = `${manifest.name} icon`;
    icon.className = 'miniapp_icon';
    icon.style.width = '50px';
    icon.style.height = '50px';
    icon.style.marginRight = '10px';

    const textContainer = document.createElement('div');
    textContainer.className = 'miniapp_text_container';

    const nameElement = document.createElement('div');
    nameElement.className = 'miniapp_name';
    nameElement.textContent = manifest.name;

    const descriptionElement = document.createElement('div');
    descriptionElement.className = 'miniapp_description';
    descriptionElement.textContent = manifest.description;

    textContainer.appendChild(nameElement);
    textContainer.appendChild(descriptionElement);

    button.appendChild(icon);
    button.appendChild(textContainer);
    item.appendChild(button);

    if (manifest.extension === "True") {
        createExtensionButton(manifest);
    }

    return item;
}

/**
 * Creates a button for a chat extension.
 *
 * This function gets the manifest data and uses it to create a button for the chat extension,
 * which is then appended to the attach-menu.
 *
 * @param {Object} manifest - The manifest data of the chat extension.
 * @param {string} manifest.extensionText - The text to display on the extension button.
 * @param {string} manifest.extensionInit - The initialization function for the extension as a string.
 */
function createExtensionButton(manifest) {
    //console.log("Extension entered")
    const attachMenu = document.getElementById('attach-menu');

    // Create a new button element
    const newButton = document.createElement('button');

    // Set the button's class
    newButton.className = 'attach-menu-item-button';

    // Set the button's text content
    newButton.textContent = manifest.extensionText;

    // Set the button's onclick event
    newButton.addEventListener('click', () => {
        try {
            // Dynamically evaluate the init function
            eval(manifest.extensionInit);
        } catch (error) {
            console.error(`Error executing extensionInit function: ${manifest.extensionInit}`, error);
        }
    });

    // Append the new button to the target div
    attachMenu.appendChild(newButton);
}


