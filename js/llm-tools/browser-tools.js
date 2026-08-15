/* Native tools — Browser automation: drive a headless Chromium session
   (Chrome DevTools Protocol). Navigate, click, type, and "see" the page.
   Executed server-side via /api/tools/execute (see server.js). A Chromium/
   Chrome binary must be installed on the host (auto-detected, or set
   CHROMIUM_PATH). Alternatively point BROWSER_CDP_URL at a remote Chrome. */

TricorderNativeTools.register([
    {
        type: 'function',
        function: {
            name: 'browser_navigate',
            description: 'Open a URL in the headless browser session and wait for it to load. Returns the final URL (after redirects), page title, a digest of visible text, and a numbered list of interactive elements (links, buttons, inputs) you can target with browser_click / browser_type. The session persists across calls so you can navigate, then interact, then read. Use this to start any web task.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to open (https:// assumed if no scheme given)' },
                    wait_ms: { type: 'number', description: 'Extra time to wait after load for dynamic content (default 0, max 10000)' }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_click',
            description: 'Click an element in the current page. Target it by CSS selector OR by the element index from the last browser_navigate / browser_vision element list OR by visible link/button text. Returns the resulting page state (URL, title, text digest, elements) so you can see what changed.',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector of the element to click (e.g. "button.submit", "a#login")' },
                    index: { type: 'number', description: 'Index of the element from the last returned element list' },
                    text: { type: 'string', description: 'Visible text of a link/button to click (case-insensitive substring match)' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_type',
            description: 'Type text into an input, textarea, or contenteditable field, then optionally submit. Target by CSS selector or element index. Use submit:true to press Enter after typing (e.g. to run a search).',
            parameters: {
                type: 'object',
                properties: {
                    selector: { type: 'string', description: 'CSS selector of the field' },
                    index: { type: 'number', description: 'Index of the field from the last returned element list' },
                    text: { type: 'string', description: 'Text to type into the field' },
                    submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
                    clear: { type: 'boolean', description: 'Clear the field before typing (default true)' }
                },
                required: ['text']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'browser_vision',
            description: 'Capture the current page: saves a PNG screenshot to the workspace and returns its path, the page title/URL, the full visible-text extraction, and the interactive element list. Use this to "look" at a page, read its content, or recover the element list before clicking/typing. Optionally scroll first.',
            parameters: {
                type: 'object',
                properties: {
                    scroll: { type: 'string', enum: ['top', 'bottom', 'down', 'up'], description: 'Scroll the page before capturing (optional)' },
                    full_page: { type: 'boolean', description: 'Capture the entire scrollable page instead of just the viewport (default false)' }
                },
                required: []
            }
        }
    }
]);
