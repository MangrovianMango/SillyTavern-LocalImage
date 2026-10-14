/* global SillyTavern */
import { createRoot } from 'react-dom/client';
import Gallery from './Gallery';
import GroupGallery from './GroupGallery';

const EXTENSION_NAME = 'SillyTavern-LocalImage';
const BUTTON_ID = 'local_image_button';
const FLOATING_BUTTON_ID = 'local_image_floating_button';
const FLOATING_PANEL_ID = 'local_image_floating_panel';

let galleryRoot = null;
let galleryContainer = null;
let floatingPanelExpanded = false;

/**
 * Initialize extension settings
 */
function initSettings() {
    const context = SillyTavern.getContext();
    const defaultSettings = {
        enabled: true,
        // assignments: { characterName: { imageName: { path: "...", description: "..." } } }
        assignments: {},
        // characterSettings: { characterName: { injectPrompt: true, selectedPromptId: "default" } }
        characterSettings: {},
        // customPrompts: [{ id: "uuid", name: "My Prompt", template: "..." }]
        customPrompts: [],
    };

    if (!context.extensionSettings[EXTENSION_NAME]) {
        context.extensionSettings[EXTENSION_NAME] = {};
    }

    Object.assign(context.extensionSettings[EXTENSION_NAME], {
        ...defaultSettings,
        ...context.extensionSettings[EXTENSION_NAME],
    });

    // Normalize invalid legacy settings before migrating string assignments.
    const settings = context.extensionSettings[EXTENSION_NAME];
    for (const key of ['assignments', 'characterSettings']) {
        if (!settings[key] || typeof settings[key] !== 'object' || Array.isArray(settings[key])) {
            settings[key] = {};
        }
    }
    if (!Array.isArray(settings.customPrompts)) settings.customPrompts = [];
    // Migrate old format (string paths) to new format (objects with path/description)
    if (settings.assignments) {
        for (const charName of Object.keys(settings.assignments)) {
            const assignments = settings.assignments[charName];
            if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) {
                delete settings.assignments[charName];
                continue;
            }
            for (const imageName of Object.keys(settings.assignments[charName])) {
                const value = settings.assignments[charName][imageName];
                if (typeof value === 'string') {
                    settings.assignments[charName][imageName] = {
                        path: value,
                        description: ''
                    };
                }
            }
        }
    }

    return context.extensionSettings[EXTENSION_NAME];
}

/**
 * Get extension settings
 */
function getSettings() {
    const context = SillyTavern.getContext();
    return context.extensionSettings[EXTENSION_NAME] || {};
}

/**
 * Save extension settings
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    context.saveSettingsDebounced();
    scheduleLocalImageRefresh();
    updateFloatingPanel();
}

/**
 * Get current character name
 * @returns {string|null} Character name or null
 */
function getCurrentCharacterName() {
    const context = SillyTavern.getContext();
    if (context.characterId !== undefined && context.characters[context.characterId]) {
        return context.characters[context.characterId].name;
    }
    return null;
}

/**
 * Get current persona/user name
 * @returns {string|null} Persona name or null
 */
function getCurrentPersonaName() {
    const context = SillyTavern.getContext();
    // ST stores persona name in name1
    return context.name1 || null;
}

/**
 * Check if currently in a group chat
 * @returns {boolean} True if in group chat
 */
function isGroupChat() {
    const context = SillyTavern.getContext();
    const result = context.groupId !== null && context.groupId !== undefined;
    console.log(`[${EXTENSION_NAME}] isGroupChat() - groupId: ${context.groupId}, result: ${result}`);
    return result;
}

/**
 * Get current group info
 * @returns {Object|null} Group object with id, name, members, or null
 */
function getCurrentGroup() {
    const context = SillyTavern.getContext();
    if (!isGroupChat()) return null;

    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group) return null;

    console.log(`[${EXTENSION_NAME}] getCurrentGroup - raw group object:`, JSON.stringify({
        id: group.id,
        name: group.name,
        chat_id: group.chat_id,
        keys: Object.keys(group)
    }));

    return {
        id: group.id,
        name: group.name || `Group ${group.id}`,
        members: group.members || []
    };
}

/**
 * Get character names for group members
 * @param {Array} memberIds - Array of member avatar identifiers
 * @returns {Array} Array of character names
 */
function getGroupMemberNames(memberIds) {
    const context = SillyTavern.getContext();
    const names = [];

    for (const memberId of memberIds) {
        const char = context.characters.find(c => c.avatar === memberId);
        if (char) {
            names.push(char.name);
        }
    }

    return names;
}

/**
 * Resolve entity name from tag (handles {{user}}, {{char}}, {{group}} macros)
 * Uses ST's built-in macro system if available
 * @param {string} entityName - Name from tag (could be actual name or macro)
 * @returns {string} Resolved entity name
 */
function resolveEntityName(entityName) {
    const context = SillyTavern.getContext();

    // Try to use ST's built-in macro replacement
    if (context.substituteParams) {
        const resolved = context.substituteParams(entityName);
        if (resolved !== entityName) {
            return resolved;
        }
    }

    // Fallback to manual resolution
    const lowerName = entityName.toLowerCase();

    // Handle {{user}} macro
    if (lowerName === '{{user}}' || lowerName === 'user') {
        return getCurrentPersonaName() || entityName;
    }

    // Handle {{char}} macro
    if (lowerName === '{{char}}' || lowerName === 'char') {
        return getCurrentCharacterName() || entityName;
    }

    // Handle {{group}} macro
    if (lowerName === '{{group}}' || lowerName === 'group') {
        const group = getCurrentGroup();
        return group ? group.name : entityName;
    }

    return entityName;
}

/**
 * Get assignments for a character
 * @param {string} charName - Character name
 * @returns {Object} Assignments object { name: { path, description } }
 */
function getCharacterAssignments(charName) {
    const settings = getSettings();
    return Object.hasOwn(settings.assignments || {}, charName) ? settings.assignments[charName] : {};
}

/**
 * Get character-specific settings
 * @param {string} charName - Character name
 * @returns {Object} Settings object { injectPrompt, customPrefix }
 */
function getCharacterSettings(charName) {
    const settings = getSettings();
    const map = settings.characterSettings || {};
    return (Object.hasOwn(map, charName) && map[charName]) || { injectPrompt: false, selectedPromptId: 'default' };
}

/**
 * Save character-specific settings
 * @param {string} charName - Character name
 * @param {Object} charSettings - Settings to save
 */
function saveCharacterSettings(charName, charSettings) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    if (!settings.characterSettings) {
        settings.characterSettings = {};
    }
    Object.defineProperty(settings.characterSettings, charName, { value: charSettings, writable: true, enumerable: true, configurable: true });
    saveSettings();
}

/**
 * Assign a name to an image for a character
 * @param {string} charName - Character name
 * @param {string} imageName - Name to assign
 * @param {string} imagePath - Path to the image
 * @param {string} description - Description of the image
 */
function assignImage(charName, imageName, imagePath, description = '') {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    if (!settings.assignments) {
        settings.assignments = {};
    }
    if (!Object.hasOwn(settings.assignments, charName)) {
        Object.defineProperty(settings.assignments, charName, { value: {}, writable: true, enumerable: true, configurable: true });
    }

    Object.defineProperty(settings.assignments[charName], imageName, {
        value: { path: imagePath, description }, writable: true, enumerable: true, configurable: true,
    });
    saveSettings();
    console.log(`[${EXTENSION_NAME}] Assigned "${imageName}" to "${imagePath}" for ${charName}`);
}

/**
 * Update description for an existing assignment
 * @param {string} charName - Character name
 * @param {string} imageName - Image name
 * @param {string} description - New description
 */
function updateImageDescription(charName, imageName, description) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    if (settings.assignments?.[charName]?.[imageName]) {
        settings.assignments[charName][imageName].description = description;
        saveSettings();
    }
}

/**
 * Remove an assignment
 * @param {string} charName - Character name
 * @param {string} imageName - Name to unassign
 */
function unassignImage(charName, imageName) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    if (settings.assignments?.[charName]?.[imageName]) {
        delete settings.assignments[charName][imageName];
        saveSettings();
        console.log(`[${EXTENSION_NAME}] Unassigned "${imageName}" for ${charName}`);
    }
}

/**
 * Get image path by character and name
 * @param {string} charName - Character name
 * @param {string} imageName - Image name
 * @returns {string} Image path or empty string
 */
function getImagePath(charName, imageName) {
    const assignments = getCharacterAssignments(charName);
    const assignment = Object.hasOwn(assignments, imageName) ? assignments[imageName] : null;
    if (!assignment) {
        return '';
    }
    // Handle both old format (string) and new format (object)
    return typeof assignment === 'string' ? assignment : assignment.path || '';
}

/**
 * Get the default prompt template
 * @param {string} charName - Character name
 * @returns {string} Default template
 */
function getDefaultPromptTemplate(charName) {
    return `Available images for ${charName} (use ::img ${charName} name:: to display):`;
}

/**
 * Get all custom prompts
 * @returns {Array} Array of custom prompt objects
 */
function getCustomPrompts() {
    const settings = getSettings();
    return settings.customPrompts || [];
}

/**
 * Add a custom prompt
 * @param {string} name - Prompt name
 * @param {string} template - Prompt template
 * @returns {string} The new prompt's ID
 */
function addCustomPrompt(name, template) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    if (!settings.customPrompts) {
        settings.customPrompts = [];
    }

    const id = 'prompt_' + crypto.randomUUID();
    settings.customPrompts.push({ id, name, template });
    saveSettings();
    return id;
}

/**
 * Update a custom prompt
 * @param {string} id - Prompt ID
 * @param {string} name - New name
 * @param {string} template - New template
 */
function updateCustomPrompt(id, name, template) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    const prompt = settings.customPrompts?.find(p => p.id === id);
    if (prompt) {
        prompt.name = name;
        prompt.template = template;
        saveSettings();
    }
}

/**
 * Delete a custom prompt
 * @param {string} id - Prompt ID
 */
function deleteCustomPrompt(id) {
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[EXTENSION_NAME];

    if (settings.customPrompts) {
        settings.customPrompts = settings.customPrompts.filter(p => p.id !== id);
        saveSettings();
    }
}

/**
 * Get a prompt template by ID
 * @param {string} id - Prompt ID ('default' or custom ID)
 * @param {string} charName - Character name (for default template)
 * @returns {string} The prompt template
 */
function getPromptTemplate(id, charName) {
    if (!id || id === 'default') {
        return getDefaultPromptTemplate(charName);
    }

    const customPrompts = getCustomPrompts();
    const prompt = customPrompts.find(p => p.id === id);
    return prompt ? prompt.template : getDefaultPromptTemplate(charName);
}

/**
 * Generate the image list prompt for a character
 * @param {string} charName - Character name
 * @returns {string} Formatted prompt text
 */
function generateImageListPrompt(charName) {
    const assignments = getCharacterAssignments(charName);
    const charSettings = getCharacterSettings(charName);

    const imageNames = Object.keys(assignments);
    if (imageNames.length === 0) return '';

    const lines = imageNames.map(name => {
        const assignment = assignments[name];
        const desc = assignment && typeof assignment === 'object' ? assignment.description : '';
        return desc ? `- ${name}: ${desc}` : `- ${name}`;
    });

    // Get the selected prompt template
    const template = getPromptTemplate(charSettings.selectedPromptId, charName);

    // Replace {{char}} placeholder with character name
    const prefix = template.replace(/\{\{char\}\}/gi, charName);

    return `[${prefix}\n${lines.join('\n')}]`;
}

/** Remove image commands without altering paragraphs, indentation or spacing. */
function stripImageTags(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/::img[ \t]+([^\r\n]*?)::/gi, '');
}

const localImageTagPattern = /::img[ \t]+([^\r\n]*?)::/gi;
const localImageNodeState = new WeakMap();
const localImageTimers = new Map();
let localImageObserver = null;
let localImageChatContainer = null;

function scheduleLocalImageRefresh(delay = 100) {
    if (localImageTimers.has(delay)) clearTimeout(localImageTimers.get(delay));
    localImageTimers.set(delay, setTimeout(() => {
        localImageTimers.delete(delay);
        processAllMessages();
    }, delay));
}

function scheduleLocalImageFinalRefresh() {
    // Events can precede the final DOM update. The observer also handles later updates.
    for (const delay of [0, 100, 500]) scheduleLocalImageRefresh(delay);
}

function resolveLocalImage(content, message) {
    const parts = content.trim().match(/^(.+?)\s+(\S+)$/);
    if (!parts) return null;
    let entity = parts[1].trim();
    const name = parts[2];
    // In a group, {{char}} refers to the speaker of this message.
    if (/^(?:\{\{char\}\}|char)$/i.test(entity) && !message.is_user && message.name) {
        entity = message.name;
    } else {
        entity = resolveEntityName(entity);
    }
    let path = getImagePath(entity, name);
    if (!path && !message.is_user && message.name) path = getImagePath(message.name, name);
    if (!path) {
        const current = getCurrentCharacterName();
        if (current) path = getImagePath(current, name);
    }
    if (!path) {
        const persona = getCurrentPersonaName();
        if (persona) path = getImagePath(persona, name);
    }
    if (typeof path !== 'string' || !path.trim()) return null;
    path = path.trim();
    // Assignments contain local server paths. Never interpret a URL or protocol as a path.
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path) || /[\r\n\0]/.test(path)) return null;
    return { name, src: '/' + path.replace(/^\/+/, '') };
}

function createLocalImage(command, image) {
    const wrapper = document.createElement('span');
    wrapper.className = 'localimage-command';
    const img = document.createElement('img');
    img.src = image.src;
    img.alt = image.name;
    img.className = 'localimage-inserted';
    img.loading = 'lazy';
    img.style.cssText = 'max-width: 100%; border-radius: 8px; margin: 5px 0; display: block;';
    wrapper.appendChild(img);
    localImageNodeState.set(wrapper, { command, src: image.src, name: image.name });
    return wrapper;
}

function processMessageElement(mesElement) {
    const mesText = mesElement.querySelector('.mes_text');
    const id = mesElement.getAttribute('mesid');
    if (!mesText || id === null || !/^\d+$/.test(id)) return;
    // Leave the message editor, code examples and other interactive UI alone.
    if (mesElement.querySelector('.mes_edit_textarea') || mesText.isContentEditable) return;
    const message = SillyTavern.getContext().chat?.[Number(id)];
    if (!message) return;
    const enabled = getSettings().enabled !== false;

    // Reconcile our own images if assignments/settings changed. A swipe normally
    // removes these nodes when ST renders the new message, so no signature cache is needed.
    for (const wrapper of mesText.querySelectorAll('.localimage-command')) {
        const state = localImageNodeState.get(wrapper);
        if (!state) continue; // Do not modify an unrelated element with the same class.
        const match = [...state.command.matchAll(localImageTagPattern)][0];
        const image = enabled && match ? resolveLocalImage(match[1], message) : null;
        if (!image) {
            wrapper.replaceWith(document.createTextNode(state.command));
        } else if (state.src !== image.src || state.name !== image.name || !wrapper.querySelector('img')) {
            wrapper.replaceWith(createLocalImage(state.command, image));
        }
    }
    if (!enabled) return;

    // Read contiguous visible text even when native formatting splits a command
    // across several inline nodes. Block boundaries and code/UI stay separate.
    for (const run of collectLocalImageTextRuns(mesText)) {
        const text = run.map(node => node.nodeValue).join('');
        const segments = [];
        let offset = 0;
        for (const node of run) {
            segments.push({ node, start: offset, end: offset + node.nodeValue.length });
            offset += node.nodeValue.length;
        }
        // Work backwards so earlier offsets still refer to the same text.
        for (const match of [...text.matchAll(localImageTagPattern)].reverse()) {
            const image = resolveLocalImage(match[1], message);
            if (!image) continue;
            const start = match.index;
            const end = start + match[0].length;
            const covered = segments.filter(part => part.end > start && part.start < end);
            if (!covered.length) continue;
            const first = covered[0];
            const last = covered[covered.length - 1];
            const startOffset = start - first.start;
            const endOffset = end - last.start;
            const prefix = first.node.nodeValue.slice(0, startOffset);
            const insertions = [createLocalImage(match[0], image)];
            if (first === last) {
                insertions.push(document.createTextNode(first.node.nodeValue.slice(endOffset)));
            } else {
                for (const part of covered.slice(1, -1)) part.node.nodeValue = '';
                last.node.nodeValue = last.node.nodeValue.slice(endOffset);
            }
            // Keep the original start node as the prefix: offsets for earlier
            // commands within this same text node remain valid.
            first.node.nodeValue = prefix;
            // Insert immediately after the prefix without replacing its ancestors.
            first.node.after(...insertions);
        }
    }
}

function collectLocalImageTextRuns(root) {
    const runs = [];
    let run = [];
    const flush = () => {
        if (run.length) runs.push(run);
        run = [];
    };
    const excluded = 'code, pre, a, script, style, textarea, button, .localimage-command, [contenteditable="true"]';
    const blocks = new Set(['P', 'DIV', 'BR', 'HR', 'BLOCKQUOTE', 'LI', 'UL', 'OL',
        'TABLE', 'TR', 'TD', 'TH', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const visit = node => {
        if (node.nodeType === Node.TEXT_NODE) {
            run.push(node);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches(excluded) || node.tagName === 'IMG') {
            flush();
            return;
        }
        const block = blocks.has(node.tagName);
        if (block) flush();
        for (const child of node.childNodes) visit(child);
        if (block) flush();
    };
    for (const child of root.childNodes) visit(child);
    flush();
    return runs;
}

function observeLocalImageChat() {
    const chat = document.getElementById('chat');
    if (chat === localImageChatContainer) return;
    localImageObserver?.disconnect();
    localImageChatContainer = chat;
    if (!chat) return;
    localImageObserver ??= new MutationObserver(() => {
        scheduleLocalImageRefresh();
    });
    localImageObserver.observe(chat, { childList: true, subtree: true, characterData: true });
    scheduleLocalImageRefresh();
}

function processAllMessages() {
    observeLocalImageChat();
    // Disconnect during our changes so they cannot schedule an observer feedback loop.
    localImageObserver?.disconnect();
    try {
        for (const element of document.querySelectorAll('#chat .mes')) {
            try {
                processMessageElement(element);
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] Could not process message`, error);
            }
        }
    } finally {
        if (localImageChatContainer?.isConnected) {
            localImageObserver?.observe(localImageChatContainer, {
                childList: true, subtree: true, characterData: true,
            });
        }
    }
}

function registerMessageHandler() {
    observeLocalImageChat();
    scheduleLocalImageFinalRefresh();
}


/**
 * Open the gallery modal
 */
function openGallery() {
    const charName = getCurrentCharacterName();
    if (!charName) {
        console.warn(`[${EXTENSION_NAME}] No character selected`);
        return;
    }

    // Create container if not exists
    if (!galleryContainer) {
        galleryContainer = document.createElement('div');
        galleryContainer.id = 'local-image-gallery-root';
        document.body.appendChild(galleryContainer);
        galleryRoot = createRoot(galleryContainer);
    }

    const assignments = getCharacterAssignments(charName);
    const charSettings = getCharacterSettings(charName);
    const customPrompts = getCustomPrompts();

    // Render gallery
    galleryRoot.render(
        <Gallery
            characterName={charName}
            onClose={closeGallery}
            assignments={assignments}
            characterSettings={charSettings}
            customPrompts={customPrompts}
            onAssign={(name, path, description) => {
                assignImage(charName, name, path, description);
                // Re-render to update assignments display
                openGallery();
            }}
            onUnassign={(name) => {
                unassignImage(charName, name);
                openGallery();
            }}
            onUpdateDescription={(name, description) => {
                updateImageDescription(charName, name, description);
                openGallery();
            }}
            onSaveSettings={(settings) => {
                saveCharacterSettings(charName, settings);
                openGallery();
            }}
            onAddPrompt={(name, template) => {
                const id = addCustomPrompt(name, template);
                openGallery();
                return id;
            }}
            onEditPrompt={(id, name, template) => {
                updateCustomPrompt(id, name, template);
                openGallery();
            }}
            onDeletePrompt={(id) => {
                deleteCustomPrompt(id);
                openGallery();
            }}
        />
    );
}

/**
 * Open the gallery modal for persona/user
 */
function openPersonaGallery() {
    const personaName = getCurrentPersonaName();
    if (!personaName) {
        console.warn(`[${EXTENSION_NAME}] No persona selected`);
        return;
    }

    // Create container if not exists
    if (!galleryContainer) {
        galleryContainer = document.createElement('div');
        galleryContainer.id = 'local-image-gallery-root';
        document.body.appendChild(galleryContainer);
        galleryRoot = createRoot(galleryContainer);
    }

    const assignments = getCharacterAssignments(personaName);
    const charSettings = getCharacterSettings(personaName);
    const customPrompts = getCustomPrompts();

    // Render gallery
    galleryRoot.render(
        <Gallery
            characterName={personaName}
            onClose={closeGallery}
            assignments={assignments}
            characterSettings={charSettings}
            customPrompts={customPrompts}
            onAssign={(name, path, description) => {
                assignImage(personaName, name, path, description);
                openPersonaGallery();
            }}
            onUnassign={(name) => {
                unassignImage(personaName, name);
                openPersonaGallery();
            }}
            onUpdateDescription={(name, description) => {
                updateImageDescription(personaName, name, description);
                openPersonaGallery();
            }}
            onSaveSettings={(settings) => {
                saveCharacterSettings(personaName, settings);
                openPersonaGallery();
            }}
            onAddPrompt={(name, template) => {
                const id = addCustomPrompt(name, template);
                openPersonaGallery();
                return id;
            }}
            onEditPrompt={(id, name, template) => {
                updateCustomPrompt(id, name, template);
                openPersonaGallery();
            }}
            onDeletePrompt={(id) => {
                deleteCustomPrompt(id);
                openPersonaGallery();
            }}
            isPersona={true}
        />
    );
}

/**
 * Close the gallery modal
 */
function closeGallery() {
    if (galleryRoot) {
        galleryRoot.render(null);
    }
}

/**
 * Open the group gallery modal
 */
function openGroupGallery() {
    const group = getCurrentGroup();
    if (!group) {
        console.warn(`[${EXTENSION_NAME}] No group selected`);
        return;
    }

    // Create container if not exists
    if (!galleryContainer) {
        galleryContainer = document.createElement('div');
        galleryContainer.id = 'local-image-gallery-root';
        document.body.appendChild(galleryContainer);
        galleryRoot = createRoot(galleryContainer);
    }

    const memberNames = getGroupMemberNames(group.members);

    // Gather all member assignments
    const memberAssignments = {};
    for (const memberName of memberNames) {
        memberAssignments[memberName] = getCharacterAssignments(memberName);
    }

    // Group assignments use the group name as the key
    const groupAssignments = getCharacterAssignments(group.name);
    const groupSettings = getCharacterSettings(group.name);
    const customPrompts = getCustomPrompts();

    // Render group gallery
    galleryRoot.render(
        <GroupGallery
            groupName={group.name}
            groupId={group.id}
            memberNames={memberNames}
            memberAssignments={memberAssignments}
            groupAssignments={groupAssignments}
            groupSettings={groupSettings}
            customPrompts={customPrompts}
            onClose={closeGallery}
            onAssignGroup={(name, path, description) => {
                assignImage(group.name, name, path, description);
                openGroupGallery();
            }}
            onUnassignGroup={(name) => {
                unassignImage(group.name, name);
                openGroupGallery();
            }}
            onUpdateGroupDescription={(name, description) => {
                updateImageDescription(group.name, name, description);
                openGroupGallery();
            }}
            onSaveGroupSettings={(settings) => {
                saveCharacterSettings(group.name, settings);
                openGroupGallery();
            }}
            onAddPrompt={(name, template) => {
                const id = addCustomPrompt(name, template);
                openGroupGallery();
                return id;
            }}
            onEditPrompt={(id, name, template) => {
                updateCustomPrompt(id, name, template);
                openGroupGallery();
            }}
            onDeletePrompt={(id) => {
                deleteCustomPrompt(id);
                openGroupGallery();
            }}
        />
    );
}

const PERSONA_BUTTON_ID = 'local_image_persona_button';

/**
 * Add the gallery button for persona
 */
function addPersonaGalleryButton() {
    // Remove existing button if any
    const existingButton = document.getElementById(PERSONA_BUTTON_ID);
    if (existingButton) {
        existingButton.remove();
    }

    // Find the persona controls buttons block (in persona management panel)
    const personaButtonsBlock = document.querySelector('.persona_controls_buttons_block');
    if (!personaButtonsBlock) {
        // Retry after a short delay
        setTimeout(addPersonaGalleryButton, 1000);
        return;
    }

    // Create the button
    const button = document.createElement('div');
    button.id = PERSONA_BUTTON_ID;
    button.className = 'menu_button fa-solid fa-images';
    button.title = 'Persona Images';
    button.setAttribute('data-i18n', '[title]Persona Images');

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPersonaGallery();
    });

    // Add to persona controls
    personaButtonsBlock.appendChild(button);

    console.log(`[${EXTENSION_NAME}] Persona gallery button added`);
}

/**
 * Remove the persona gallery button
 */
function removePersonaGalleryButton() {
    const button = document.getElementById(PERSONA_BUTTON_ID);
    if (button) {
        button.remove();
    }
}

/**
 * Handle character/group selection change
 */
function onChatChanged() {
    const inGroup = isGroupChat();
    console.log(`[${EXTENSION_NAME}] onChatChanged called, isGroupChat: ${inGroup}`);

    // Remove existing button
    const existingButton = document.getElementById(BUTTON_ID);
    if (existingButton) {
        existingButton.remove();
    }

    // Create the button
    const button = document.createElement('div');
    button.id = BUTTON_ID;
    button.className = 'menu_button fa-solid fa-images interactable';

    if (inGroup) {
        // Group gallery is COMING SOON - don't show button for now
        console.log(`[${EXTENSION_NAME}] Group chat detected - group gallery coming soon`);
        return;
    } else {
        // Single character chat - find the export button
        const exportButton = document.getElementById('export_button');
        if (!exportButton || !exportButton.parentElement) {
            // Retry after a short delay
            setTimeout(onChatChanged, 500);
            return;
        }

        const charName = getCurrentCharacterName();
        if (!charName) return; // No character selected

        button.title = 'Local Images';
        button.setAttribute('data-i18n', '[title]Local Images');
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openGallery();
        });

        // Insert after the export button
        const buttonContainer = exportButton.parentElement;
        if (exportButton.nextSibling) {
            buttonContainer.insertBefore(button, exportButton.nextSibling);
        } else {
            buttonContainer.appendChild(button);
        }
        console.log(`[${EXTENSION_NAME}] Gallery button added (character mode)`);
    }
}


/**
 * Send a message as /sys (narrator) without triggering AI response
 * @param {string} message - The message to send
 */
function sendAsNarrator(message) {
    const textarea = document.getElementById('send_textarea');
    const sendButton = document.getElementById('send_but');

    if (!textarea || !sendButton) {
        console.error(`[${EXTENSION_NAME}] Could not find send textarea or button`);
        return;
    }

    // Set the message with /sys prefix
    textarea.value = `/sys ${message}`;

    // Trigger input event so ST knows the value changed
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    // Click the send button
    sendButton.click();

    console.log(`[${EXTENSION_NAME}] Sent narrator message: ${message}`);
}

/**
 * Get all entities (persona + characters) that have images assigned
 * @returns {Array} Array of { name, type, images } objects
 */
function getEntitiesWithImages() {
    const entities = [];
    const settings = getSettings();

    // Add persona if has images
    const personaName = getCurrentPersonaName();
    if (personaName) {
        const personaAssignments = getCharacterAssignments(personaName);
        const imageNames = Object.keys(personaAssignments);
        if (imageNames.length > 0) {
            entities.push({
                name: personaName,
                type: 'persona',
                images: imageNames
            });
        }
    }

    // Add character(s)
    if (isGroupChat()) {
        const group = getCurrentGroup();
        if (group) {
            const memberNames = getGroupMemberNames(group.members);
            for (const memberName of memberNames) {
                const assignments = getCharacterAssignments(memberName);
                const imageNames = Object.keys(assignments);
                if (imageNames.length > 0) {
                    entities.push({
                        name: memberName,
                        type: 'character',
                        images: imageNames
                    });
                }
            }
        }
    } else {
        const charName = getCurrentCharacterName();
        if (charName) {
            const assignments = getCharacterAssignments(charName);
            const imageNames = Object.keys(assignments);
            if (imageNames.length > 0) {
                entities.push({
                    name: charName,
                    type: 'character',
                    images: imageNames
                });
            }
        }
    }

    return entities;
}

/**
 * Create the floating button element
 */
function createFloatingButton() {
    // Remove existing if any
    const existing = document.getElementById(FLOATING_BUTTON_ID);
    if (existing) existing.remove();

    const button = document.createElement('div');
    button.id = FLOATING_BUTTON_ID;
    button.className = 'local-image-floating-button';
    button.innerHTML = '<i class="fa-solid fa-images"></i>';
    button.title = 'Quick Image Send';

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFloatingPanel();
    });

    document.body.appendChild(button);
    // Position using top instead of bottom to avoid transform issues
    const updatePosition = () => {
        const viewportHeight = window.innerHeight;
        button.style.top = (viewportHeight - 140) + 'px';
        button.style.bottom = 'auto';
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    console.log(`[${EXTENSION_NAME}] Floating button created`);
}

/**
 * Toggle the floating panel open/closed
 */
function toggleFloatingPanel() {
    floatingPanelExpanded = !floatingPanelExpanded;

    if (floatingPanelExpanded) {
        createFloatingPanel();
    } else {
        closeFloatingPanel();
    }
}

/**
 * Create and show the floating panel
 */
function createFloatingPanel() {
    // Remove existing if any
    closeFloatingPanel();

    const entities = getEntitiesWithImages();

    // Don't show panel if no entities have images
    if (entities.length === 0) {
        floatingPanelExpanded = false;
        console.log(`[${EXTENSION_NAME}] No entities with images, not showing panel`);
        return;
    }

    const panel = document.createElement('div');
    panel.id = FLOATING_PANEL_ID;
    panel.className = 'local-image-floating-panel';

    // Header with close button
    const header = document.createElement('div');
    header.className = 'floating-panel-header';
    header.innerHTML = `
        <span>Quick Image Send</span>
        <button class="floating-panel-close" title="Close">
            <i class="fa-solid fa-times"></i>
        </button>
    `;
    panel.appendChild(header);

    // Close button handler
    header.querySelector('.floating-panel-close').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        floatingPanelExpanded = false;
        closeFloatingPanel();
    });

    // Content area with entity rows
    const content = document.createElement('div');
    content.className = 'floating-panel-content';

    for (const entity of entities) {
        const row = document.createElement('div');
        row.className = 'floating-panel-row';

        const label = document.createElement('span');
        label.className = 'floating-panel-label';
        label.textContent = entity.name;
        if (entity.type === 'persona') {
            const suffix = document.createElement('small');
            suffix.textContent = ' (you)';
            label.appendChild(suffix);
        }
        row.appendChild(label);

        const controls = document.createElement('div');
        controls.className = 'floating-panel-controls';

        const select = document.createElement('select');
        select.className = 'floating-panel-select';
        select.dataset.entityName = entity.name;

        for (const imageName of entity.images) {
            const option = document.createElement('option');
            option.value = imageName;
            option.textContent = imageName;
            select.appendChild(option);
        }
        controls.appendChild(select);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'floating-panel-send';
        sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
        sendBtn.title = 'Send image';
        sendBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const selectedImage = select.value;
            if (selectedImage) {
                sendAsNarrator(`::img ${entity.name} ${selectedImage}::`);
            }
        });
        controls.appendChild(sendBtn);

        row.appendChild(controls);
        content.appendChild(row);
    }

    panel.appendChild(content);
    document.body.appendChild(panel);
    // Position using top instead of bottom to avoid transform issues
    const viewportHeight = window.innerHeight;
    const panelHeight = Math.min(350, panel.offsetHeight);
    panel.style.top = (viewportHeight - 140 - panelHeight - 10) + 'px';
    panel.style.bottom = 'auto';

    console.log(`[${EXTENSION_NAME}] Floating panel created with ${entities.length} entities`);
}

/**
 * Close and remove the floating panel
 */
function closeFloatingPanel() {
    const panel = document.getElementById(FLOATING_PANEL_ID);
    if (panel) {
        panel.remove();
    }
}

/**
 * Update the floating panel content (called on chat change)
 */
function updateFloatingPanel() {
    if (floatingPanelExpanded) {
        createFloatingPanel();
    }
}

/**
 * Initialize the extension
 */
function init() {
    document.documentElement?.setAttribute('data-localimage-patch', 'v9');
    console.log(`[${EXTENSION_NAME}] Loaded patch v9 (native formatting preserved)`);
    initSettings();
    registerMessageHandler();

    const context = SillyTavern.getContext();

    // Subscribe to chat events
    console.log(`[${EXTENSION_NAME}] eventSource exists:`, !!context.eventSource, 'eventTypes exists:', !!context.eventTypes);
    if (context.eventSource && context.eventTypes) {
        // Regular chat changed
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
            observeLocalImageChat();
            const ctx = SillyTavern.getContext();
            console.log(`[${EXTENSION_NAME}] CHAT_CHANGED event received - groupId: ${ctx.groupId}, characterId: ${ctx.characterId}`);
            onChatChanged();
            updateFloatingPanel();
            setTimeout(processAllMessages, 500);
        });

        // Group chat specific event
        if (context.eventTypes.GROUP_CHAT_CHANGED) {
            context.eventSource.on(context.eventTypes.GROUP_CHAT_CHANGED, () => {
                console.log(`[${EXTENSION_NAME}] GROUP_CHAT_CHANGED event received`);
                onChatChanged();
                updateFloatingPanel();
                setTimeout(processAllMessages, 500);
            });
        }

        // Also try listening to chatLoaded if available
        if (context.eventTypes.CHAT_LOADED) {
            context.eventSource.on(context.eventTypes.CHAT_LOADED, () => {
                console.log(`[${EXTENSION_NAME}] CHAT_LOADED event received`);
                onChatChanged();
                updateFloatingPanel();
                setTimeout(processAllMessages, 500);
            });
        }

        console.log(`[${EXTENSION_NAME}] Event subscriptions registered`);

        // DOM-only insertion is safe after each native render. Do not gate it on
        // generation events: dry runs/aborts may emit STARTED without an end event.
        const refreshAfterRender = () => scheduleLocalImageFinalRefresh();
        for (const eventName of [
            'MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED',
            'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_SWIPED',
            'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MORE_MESSAGES_LOADED', 'MESSAGE_DELETED',
            'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED',
        ]) {
            if (context.eventTypes[eventName]) {
                context.eventSource.on(context.eventTypes[eventName], refreshAfterRender);
            }
        }
        // Listen for prompt generation to inject image list
        if (context.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS) {
            context.eventSource.on(context.eventTypes.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
                const prompts = [];

                // Handle group chats
                if (isGroupChat()) {
                    const group = getCurrentGroup();
                    if (group) {
                        const groupSettings = getCharacterSettings(group.name);
                        if (groupSettings.injectPrompt) {
                            const groupPrompt = generateImageListPrompt(group.name);
                            if (groupPrompt) prompts.push(groupPrompt);
                        }

                        // Also inject member image lists if they have injectPrompt enabled
                        const memberNames = getGroupMemberNames(group.members);
                        for (const memberName of memberNames) {
                            const memberSettings = getCharacterSettings(memberName);
                            if (memberSettings.injectPrompt) {
                                const memberPrompt = generateImageListPrompt(memberName);
                                if (memberPrompt) prompts.push(memberPrompt);
                            }
                        }
                    }
                } else {
                    // Single character chat
                    const charName = getCurrentCharacterName();
                    if (charName) {
                        const charSettings = getCharacterSettings(charName);
                        if (charSettings.injectPrompt) {
                            const prompt = generateImageListPrompt(charName);
                            if (prompt) prompts.push(prompt);
                        }
                    }
                }

                const persona = getCurrentPersonaName();
                if (persona && getCharacterSettings(persona).injectPrompt) {
                    const personaPrompt = generateImageListPrompt(persona);
                    if (personaPrompt && !prompts.includes(personaPrompt)) prompts.push(personaPrompt);
                }

                // Always update or clear the same key; never carry a previous chat's list.
                const combinedPrompt = getSettings().enabled !== false ? prompts.join('\n\n') : '';
                SillyTavern.getContext().setExtensionPrompt(EXTENSION_NAME, combinedPrompt, 1, 0);
            });
        }

        // Strip ::img:: tags from chat messages before sending to AI
        // Preserve system instructions describing how to use the commands.
        if (context.eventTypes.CHAT_COMPLETION_PROMPT_READY) {
            context.eventSource.on(context.eventTypes.CHAT_COMPLETION_PROMPT_READY, (data) => {
                if (getSettings().enabled === false || !Array.isArray(data?.messages)) return;

                // Strip commands from conversation content, preserving prompt instructions.
                for (const message of data.messages) {
                    if (!message || typeof message !== 'object') continue;
                    // System/developer instructions contain the image command usage examples.
                    if (message.role === 'system' || message.role === 'developer') continue;
                    if (typeof message.content === 'string') {
                        message.content = stripImageTags(message.content);
                    }
                    // Handle array content (for multimodal messages)
                    if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            if (part?.type === 'text' && typeof part.text === 'string') {
                                part.text = stripImageTags(part.text);
                            }
                        }
                    }
                }
                console.log(`[${EXTENSION_NAME}] Stripped ::img:: tags from prompt`);
            });
        }
    }

    // Add buttons if chat already active
    setTimeout(() => {
        onChatChanged();
        // Always try to add persona button
        addPersonaGalleryButton();
        // Create floating button for quick image send
        createFloatingButton();
    }, 100);

    // Fallback: Use MutationObserver to detect chat changes
    // This helps when CHAT_CHANGED event doesn't fire for our extension
    let lastGroupId = null;
    let lastCharacterId = null;

    const checkAndUpdateButton = () => {
        try {
            observeLocalImageChat();
            const context = SillyTavern.getContext();
            const currentGroupId = context.groupId;
            const currentCharacterId = context.characterId;

            // Check if context changed
            if (currentGroupId !== lastGroupId || currentCharacterId !== lastCharacterId) {
                console.log(`[${EXTENSION_NAME}] Context changed - groupId: ${lastGroupId} -> ${currentGroupId}, characterId: ${lastCharacterId} -> ${currentCharacterId}`);
                lastGroupId = currentGroupId;
                lastCharacterId = currentCharacterId;
                onChatChanged();
            } else {
                // Also check if button is missing
                const existingButton = document.getElementById(BUTTON_ID);
                if (!existingButton && !isGroupChat() && getCurrentCharacterName()) {
                    const chatElement = document.getElementById('chat');
                    if (chatElement && chatElement.children.length > 0) {
                        console.log(`[${EXTENSION_NAME}] Button missing, re-adding`);
                        onChatChanged();
                    }
                }
            }
        } catch (e) {
            console.error(`[${EXTENSION_NAME}] Error in checkAndUpdateButton:`, e);
        }
    };

    // Run immediately on init
    console.log(`[${EXTENSION_NAME}] Setting up polling and observers`);
    setTimeout(checkAndUpdateButton, 500);

    const chatObserver = new MutationObserver(() => {
        checkAndUpdateButton();
    });

    // Observe the chat container for changes
    const chatContainer = document.getElementById('chat');
    if (chatContainer) {
        chatObserver.observe(chatContainer, { childList: true });
        console.log(`[${EXTENSION_NAME}] MutationObserver watching chat container`);
    }

    // Also observe the sheld container which changes when switching chat types
    const sheldContainer = document.getElementById('sheld');
    if (sheldContainer) {
        chatObserver.observe(sheldContainer, { childList: true, attributes: true, attributeFilter: ['class'] });
        console.log(`[${EXTENSION_NAME}] MutationObserver watching sheld container`);
    }

    // Retry after DOM is more ready if containers weren't found
    setTimeout(() => {
        if (!chatContainer) {
            const delayedChat = document.getElementById('chat');
            if (delayedChat) {
                chatObserver.observe(delayedChat, { childList: true });
                console.log(`[${EXTENSION_NAME}] MutationObserver watching chat container (delayed)`);
            }
        }
        if (!sheldContainer) {
            const delayedSheld = document.getElementById('sheld');
            if (delayedSheld) {
                chatObserver.observe(delayedSheld, { childList: true, attributes: true, attributeFilter: ['class'] });
                console.log(`[${EXTENSION_NAME}] MutationObserver watching sheld container (delayed)`);
            }
        }
        // Do an initial check
        checkAndUpdateButton();
    }, 1000);

    // Also poll every 2 seconds as ultimate fallback
    setInterval(checkAndUpdateButton, 2000);

    console.log(`[${EXTENSION_NAME}] Extension initialized`);
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
