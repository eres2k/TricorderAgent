/* ============================================
   File Content Extraction — Zero Dependencies
   Extracts text from PDF, DOCX, XLSX, PPTX, ZIP
   using only Node.js built-in modules (zlib, fs).
   ============================================ */

const zlib = require('zlib');

// --- ZIP Parser ---
// Minimal ZIP reader that parses the central directory and extracts entries.

function parseZipEntries(buffer) {
    // Find End of Central Directory record (scans backwards)
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) throw new Error('Not a valid ZIP file');

    const cdEntryCount = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    const entries = [];
    let offset = cdOffset;

    for (let i = 0; i < cdEntryCount && offset < eocdOffset; i++) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLen = buffer.readUInt16LE(offset + 28);
        const extraLen = buffer.readUInt16LE(offset + 30);
        const commentLen = buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.slice(offset + 46, offset + 46 + nameLen).toString('utf8');

        entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
        offset += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

function extractZipEntry(buffer, entry) {
    const lo = entry.localHeaderOffset;
    if (buffer.readUInt32LE(lo) !== 0x04034b50) {
        throw new Error('Invalid local file header');
    }
    const localNameLen = buffer.readUInt16LE(lo + 26);
    const localExtraLen = buffer.readUInt16LE(lo + 28);
    const dataOffset = lo + 30 + localNameLen + localExtraLen;
    const compressedData = buffer.slice(dataOffset, dataOffset + entry.compressedSize);

    if (entry.method === 0) return compressedData;           // Stored
    if (entry.method === 8) return zlib.inflateRawSync(compressedData);  // Deflated
    throw new Error(`Unsupported compression method: ${entry.method}`);
}

// --- DOCX Extraction ---
// DOCX is a ZIP containing word/document.xml with paragraph text.

function extractDocxText(buffer) {
    const entries = parseZipEntries(buffer);
    const docEntry = entries.find(e => e.name === 'word/document.xml');
    if (!docEntry) throw new Error('Not a valid DOCX file (word/document.xml not found)');

    const xml = extractZipEntry(buffer, docEntry).toString('utf8');

    // Extract text from <w:t> tags, respecting paragraph breaks
    let text = '';
    let inParagraph = false;

    // Process paragraph by paragraph
    const paragraphs = xml.split(/<\/w:p>/);
    for (const para of paragraphs) {
        // Extract all <w:t> text within this paragraph
        const textParts = [];
        const tRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
        let m;
        while ((m = tRegex.exec(para)) !== null) {
            textParts.push(m[1]);
        }
        if (textParts.length > 0) {
            text += textParts.join('') + '\n';
        }
    }

    // Decode XML entities
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return text;
}

// --- XLSX Extraction ---
// XLSX is a ZIP containing xl/sharedStrings.xml and xl/worksheets/sheet*.xml

function extractXlsxText(buffer) {
    const entries = parseZipEntries(buffer);

    // Read shared strings
    const ssEntry = entries.find(e => e.name === 'xl/sharedStrings.xml');
    const sharedStrings = [];
    if (ssEntry) {
        const ssXml = extractZipEntry(buffer, ssEntry).toString('utf8');
        const siRegex = /<si>([\s\S]*?)<\/si>/g;
        let m;
        while ((m = siRegex.exec(ssXml)) !== null) {
            // Extract all <t> text within this string item
            const parts = [];
            const tRegex = /<t[^>]*>([\s\S]*?)<\/t>/g;
            let t;
            while ((t = tRegex.exec(m[1])) !== null) {
                parts.push(t[1]);
            }
            sharedStrings.push(parts.join(''));
        }
    }

    // Read sheets
    const sheetEntries = entries
        .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));

    const lines = [];

    for (const sheetEntry of sheetEntries) {
        if (sheetEntries.length > 1) {
            lines.push(`\n--- ${sheetEntry.name.replace('xl/worksheets/', '').replace('.xml', '')} ---`);
        }

        const sheetXml = extractZipEntry(buffer, sheetEntry).toString('utf8');

        // Parse rows
        const rowRegex = /<row[^>]*>([\s\S]*?)<\/row>/g;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
            const cells = [];
            const cellRegex = /<c\s([^>]*)>([\s\S]*?)<\/c>/g;
            let cellMatch;
            while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
                const attrs = cellMatch[1];
                const cellContent = cellMatch[2];
                const valMatch = cellContent.match(/<v>([\s\S]*?)<\/v>/);
                if (!valMatch) { cells.push(''); continue; }

                const val = valMatch[1];
                // Check if it's a shared string reference (t="s")
                if (/t="s"/.test(attrs)) {
                    const idx = parseInt(val, 10);
                    cells.push(sharedStrings[idx] || val);
                } else {
                    cells.push(val);
                }
            }
            if (cells.some(c => c !== '')) {
                lines.push(cells.join('\t'));
            }
        }
    }

    return lines.join('\n')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();
}

// --- PPTX Extraction ---
// PPTX is a ZIP containing ppt/slides/slide*.xml

function extractPptxText(buffer) {
    const entries = parseZipEntries(buffer);

    const slideEntries = entries
        .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
        .sort((a, b) => {
            const numA = parseInt(a.name.match(/slide(\d+)/)[1], 10);
            const numB = parseInt(b.name.match(/slide(\d+)/)[1], 10);
            return numA - numB;
        });

    const lines = [];

    for (const slideEntry of slideEntries) {
        const slideNum = slideEntry.name.match(/slide(\d+)/)[1];
        lines.push(`\n--- Slide ${slideNum} ---`);

        const xml = extractZipEntry(buffer, slideEntry).toString('utf8');

        // Extract text from <a:t> tags within text body paragraphs
        const paraRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
        let paraMatch;
        while ((paraMatch = paraRegex.exec(xml)) !== null) {
            const textParts = [];
            const tRegex = /<a:t>([\s\S]*?)<\/a:t>/g;
            let tMatch;
            while ((tMatch = tRegex.exec(paraMatch[1])) !== null) {
                textParts.push(tMatch[1]);
            }
            if (textParts.length > 0) {
                lines.push(textParts.join(''));
            }
        }
    }

    return lines.join('\n')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// --- PDF Text Extraction ---
// Basic extraction: decompresses FlateDecode streams and extracts text operators.
// Works for many PDFs but not scanned/image-only documents.

function extractPdfText(buffer) {
    const raw = buffer.toString('binary');
    const textChunks = [];

    // Find and decompress all stream objects
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;

    while ((match = streamRegex.exec(raw)) !== null) {
        let streamData = match[1];

        // Check if the preceding object dictionary has FlateDecode
        const preContext = raw.substring(Math.max(0, match.index - 500), match.index);
        const isFlate = /\/FlateDecode/.test(preContext);

        if (isFlate) {
            try {
                const buf = Buffer.from(streamData, 'binary');
                streamData = zlib.inflateSync(buf).toString('binary');
            } catch {
                continue;  // can't decompress — skip
            }
        }

        // Extract text from PDF text operators
        extractTextFromStream(streamData, textChunks);
    }

    if (textChunks.length === 0) {
        // Fallback: look for raw text between parentheses in the entire file
        // This catches some simpler PDFs
        const simpleRegex = /\(([^\\)]{2,})\)/g;
        let sm;
        while ((sm = simpleRegex.exec(raw)) !== null) {
            const t = sm[1].trim();
            if (t.length > 1 && /[a-zA-Z0-9]/.test(t)) {
                textChunks.push(t);
            }
        }
    }

    let text = textChunks.join('')
        .replace(/\x00/g, '')
        .replace(/[^\x20-\x7E\n\r\t\u00A0-\uFFFF]/g, '')
        .replace(/ {3,}/g, '  ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    if (!text) {
        return '[No extractable text found. This PDF may contain only images/scans.]';
    }

    return text;
}

function extractTextFromStream(data, chunks) {
    // Track text state
    let inText = false;
    let i = 0;
    const len = data.length;

    while (i < len) {
        // BT = begin text, ET = end text
        if (data[i] === 'B' && data[i + 1] === 'T' && /\s/.test(data[i + 2] || ' ')) {
            inText = true;
            i += 2;
            continue;
        }
        if (data[i] === 'E' && data[i + 1] === 'T' && /\s/.test(data[i + 2] || ' ')) {
            inText = false;
            chunks.push('\n');
            i += 2;
            continue;
        }

        if (!inText) { i++; continue; }

        // Tj operator: (text) Tj
        if (data[i] === '(') {
            let text = '';
            let depth = 1;
            i++;
            while (i < len && depth > 0) {
                if (data[i] === '\\') {
                    i++;
                    if (data[i] === 'n') text += '\n';
                    else if (data[i] === 'r') text += '\r';
                    else if (data[i] === 't') text += '\t';
                    else if (data[i] === '(' || data[i] === ')' || data[i] === '\\') text += data[i];
                    else if (/[0-7]/.test(data[i])) {
                        // Octal escape
                        let octal = data[i];
                        if (/[0-7]/.test(data[i + 1])) { octal += data[++i]; }
                        if (/[0-7]/.test(data[i + 1])) { octal += data[++i]; }
                        text += String.fromCharCode(parseInt(octal, 8));
                    }
                } else if (data[i] === '(') {
                    depth++;
                    text += '(';
                } else if (data[i] === ')') {
                    depth--;
                    if (depth > 0) text += ')';
                } else {
                    text += data[i];
                }
                i++;
            }
            chunks.push(text);
            continue;
        }

        // TJ operator: [...] TJ — array of strings and positioning
        if (data[i] === '[') {
            i++;
            while (i < len && data[i] !== ']') {
                if (data[i] === '(') {
                    let text = '';
                    let depth = 1;
                    i++;
                    while (i < len && depth > 0) {
                        if (data[i] === '\\') {
                            i++;
                            if (data[i] === 'n') text += '\n';
                            else if (data[i] === 'r') text += '\r';
                            else if (data[i] === 't') text += '\t';
                            else if (data[i] === '(' || data[i] === ')' || data[i] === '\\') text += data[i];
                            else if (/[0-7]/.test(data[i])) {
                                let octal = data[i];
                                if (/[0-7]/.test(data[i + 1])) { octal += data[++i]; }
                                if (/[0-7]/.test(data[i + 1])) { octal += data[++i]; }
                                text += String.fromCharCode(parseInt(octal, 8));
                            }
                        } else if (data[i] === '(') {
                            depth++;
                            text += '(';
                        } else if (data[i] === ')') {
                            depth--;
                            if (depth > 0) text += ')';
                        } else {
                            text += data[i];
                        }
                        i++;
                    }
                    chunks.push(text);
                } else if (data[i] === '<') {
                    // Hex string
                    i++;
                    let hex = '';
                    while (i < len && data[i] !== '>') {
                        if (/[0-9a-fA-F]/.test(data[i])) hex += data[i];
                        i++;
                    }
                    if (hex.length > 0) {
                        // Convert hex pairs to characters
                        let text = '';
                        for (let h = 0; h < hex.length; h += 2) {
                            const code = parseInt(hex.substring(h, h + 2), 16);
                            if (code >= 32) text += String.fromCharCode(code);
                        }
                        if (text.trim()) chunks.push(text);
                    }
                    i++;
                } else {
                    // Number (kerning value) — large negative = space
                    if (data[i] === '-' || /[0-9]/.test(data[i])) {
                        let numStr = '';
                        while (i < len && (data[i] === '-' || data[i] === '.' || /[0-9]/.test(data[i]))) {
                            numStr += data[i];
                            i++;
                        }
                        const num = parseFloat(numStr);
                        if (num < -100) chunks.push(' ');
                    } else {
                        i++;
                    }
                }
            }
            i++; // skip ]
            continue;
        }

        // ' and " operators also show text (preceded by parenthesized string)
        // These are handled by the ( case above since the text comes first

        // Td/TD with large y offset = new line
        if ((data[i] === 'T' && (data[i + 1] === 'd' || data[i + 1] === 'D')) ||
            (data[i] === 'T' && data[i + 1] === '*')) {
            chunks.push('\n');
            i += 2;
            continue;
        }

        i++;
    }
}

// --- ZIP Listing ---

function listZipContents(buffer) {
    const entries = parseZipEntries(buffer);
    return entries.map(e => ({
        name: e.name,
        size: e.uncompressedSize,
        compressed: e.compressedSize,
    }));
}

// --- Read text file from ZIP ---

function readZipTextEntry(buffer, entryName) {
    const entries = parseZipEntries(buffer);
    const entry = entries.find(e => e.name === entryName);
    if (!entry) throw new Error(`Entry "${entryName}" not found in archive`);

    const data = extractZipEntry(buffer, entry);
    return data.toString('utf8');
}

// --- Dispatcher ---

const EXTRACTABLE_EXTENSIONS = new Set([
    '.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.gz'
]);

function canExtract(ext) {
    return EXTRACTABLE_EXTENSIONS.has(ext);
}

function extractText(buffer, ext) {
    switch (ext) {
        case '.pdf':   return { type: 'pdf',  text: extractPdfText(buffer) };
        case '.docx':  return { type: 'docx', text: extractDocxText(buffer) };
        case '.xlsx':  return { type: 'xlsx', text: extractXlsxText(buffer) };
        case '.pptx':  return { type: 'pptx', text: extractPptxText(buffer) };
        case '.zip':
        case '.gz': {
            const contents = listZipContents(buffer);
            const listing = contents.map(e =>
                `${e.name}  (${formatSize(e.size)})`
            ).join('\n');
            return { type: 'archive', text: `Archive contents (${contents.length} entries):\n${listing}` };
        }
        default:
            throw new Error(`Unsupported file type: ${ext}`);
    }
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

module.exports = {
    extractText,
    canExtract,
    extractPdfText,
    extractDocxText,
    extractXlsxText,
    extractPptxText,
    listZipContents,
    readZipTextEntry,
    parseZipEntries,
    extractZipEntry,
    EXTRACTABLE_EXTENSIONS,
};
