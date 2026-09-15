// middleware/upload.js
// Shared multer config, extracted out of server.js so route files (e.g.
// routes/events.js's blueprint photo proxy) can reuse the same scoped,
// MIME/size-limited upload instances instead of each defining their own.
const multer = require('multer');

// Each proxy endpoint gets its own instance scoped to the file type it
// actually handles -- no MIME check, no size cap wasn't an option here since
// these buffer the whole file into memory before forwarding it on.
function uploadFor(allowedMimePrefix, maxSizeMb) {
    return multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxSizeMb * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            if (!file.mimetype || !file.mimetype.startsWith(allowedMimePrefix)) {
                return cb(new Error(`Only ${allowedMimePrefix}* files are allowed.`));
            }
            cb(null, true);
        }
    });
}

const uploadAudio = uploadFor('audio/', 15);
const uploadImage = uploadFor('image/', 8);

// Multer surfaces fileFilter rejections and size-limit overruns as errors passed to
// next(), which would otherwise fall through to Express's default HTML error page.
function handleUploadErrors(err, req, res, next) {
    if (err instanceof multer.MulterError || err) {
        return res.status(400).json({ error: err.message || 'Upload rejected.' });
    }
    next();
}

module.exports = { uploadFor, uploadAudio, uploadImage, handleUploadErrors };
