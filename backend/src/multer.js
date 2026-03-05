/**
 * Multer Configuration Module
 * File upload handling with NFS integration, image processing, and security
 */

const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

class FileUploadHandler {
    constructor() {
        this.uploadsDir = process.env.UPLOADS_DIR || './uploads';
        this.maxFileSize = parseInt(process.env.MAX_FILE_SIZE) || 16 * 1024 * 1024; // 16MB
        this.allowedImageTypes = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'];
        this.allowedDocTypes = ['.pdf', '.doc', '.docx', '.txt', '.csv'];
        this.allowedArchiveTypes = ['.zip', '.rar'];
        this.blockedTypes = ['.exe', '.bat', '.sh', '.php', '.js', '.html', '.htm'];

        this.ensureUploadsDirectory();
    }

    /**
     * Ensure uploads directory exists and is properly configured
     */
    ensureUploadsDirectory() {
        try {
            // Check if uploads is a symlink (NFS setup)
            const stats = fs.lstatSync(this.uploadsDir);
            if (stats.isSymbolicLink()) {
                const linkTarget = fs.readlinkSync(this.uploadsDir);
                console.log(`📁 Uploads directory is symlinked to: ${linkTarget}`);
            } else {
                console.log(`📁 Uploads directory: ${this.uploadsDir}`);
            }

            // Create subdirectories
            const subdirs = ['images', 'documents', 'temp'];
            subdirs.forEach(subdir => {
                const dirPath = path.join(this.uploadsDir, subdir);
                if (!fs.existsSync(dirPath)) {
                    fs.mkdirSync(dirPath, { recursive: true });
                    console.log(`📁 Created subdirectory: ${subdir}`);
                }
            });
        } catch (error) {
            console.error('❌ Error setting up uploads directory:', error.message);
            process.exit(1);
        }
    }

    /**
     * Generate unique filename with timestamp and hash
     */
    generateFilename(originalName) {
        const timestamp = Date.now();
        const randomHash = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(originalName).toLowerCase();
        const nameWithoutExt = path.basename(originalName, ext);
        const sanitizedName = nameWithoutExt.replace(/[^a-zA-Z0-9]/g, '_');

        return `${timestamp}_${randomHash}_${sanitizedName}${ext}`;
    }

    /**
     * Determine file category based on extension
     */
    getFileCategory(filename) {
        const ext = path.extname(filename).toLowerCase();

        if (this.allowedImageTypes.includes(ext)) return 'images';
        if (this.allowedDocTypes.includes(ext)) return 'documents';
        if (this.allowedArchiveTypes.includes(ext)) return 'documents';

        return 'temp'; // Temporary storage for processing
    }

    /**
     * File filter function for security
     */
    fileFilter(req, file, cb) {
        const ext = path.extname(file.originalname).toLowerCase();

        // Block dangerous file types
        if (this.blockedTypes.includes(ext)) {
            return cb(new Error(`File type ${ext} is not allowed for security reasons`), false);
        }

        // Check if file type is allowed
        const allowedTypes = [
            ...this.allowedImageTypes,
            ...this.allowedDocTypes,
            ...this.allowedArchiveTypes
        ];

        if (!allowedTypes.includes(ext)) {
            return cb(new Error(`File type ${ext} is not supported`), false);
        }

        cb(null, true);
    }

    /**
     * Storage configuration for multer
     */
    getStorageConfig() {
        return multer.diskStorage({
            destination: (req, file, cb) => {
                const category = this.getFileCategory(file.originalname);
                const uploadPath = path.join(this.uploadsDir, category);
                cb(null, uploadPath);
            },
            filename: (req, file, cb) => {
                const filename = this.generateFilename(file.originalname);
                cb(null, filename);
            }
        });
    }

    /**
     * Get multer configuration for single file upload
     */
    single(fieldName = 'file') {
        return multer({
            storage: this.getStorageConfig(),
            fileFilter: this.fileFilter.bind(this),
            limits: {
                fileSize: this.maxFileSize,
                fieldNameSize: 100,
                fieldSize: 1024 * 1024 // 1MB for text fields
            }
        }).single(fieldName);
    }

    /**
     * Get multer configuration for multiple file upload
     */
    multiple(fieldName = 'files', maxCount = 10) {
        return multer({
            storage: this.getStorageConfig(),
            fileFilter: this.fileFilter.bind(this),
            limits: {
                fileSize: this.maxFileSize,
                files: maxCount,
                fieldNameSize: 100,
                fieldSize: 1024 * 1024
            }
        }).array(fieldName, maxCount);
    }

    /**
     * Process uploaded image (resize, optimize)
     */
    async processImage(filePath, options = {}) {
        try {
            const {
                width = 1200,
                height = null,
                quality = 85,
                format = 'jpeg',
                createThumbnail = true,
                thumbnailSize = 300
            } = options;

            const ext = path.extname(filePath);
            const basename = path.basename(filePath, ext);
            const dirname = path.dirname(filePath);

            // Process main image
            const processedPath = path.join(dirname, `${basename}_processed.${format}`);

            let sharpInstance = sharp(filePath);

            if (width || height) {
                sharpInstance = sharpInstance.resize(width, height, {
                    fit: 'inside',
                    withoutEnlargement: true
                });
            }

            await sharpInstance
                .jpeg({ quality, progressive: true })
                .png({ compressionLevel: 9, progressive: true })
                .webp({ quality, effort: 6 })
                .toFile(processedPath);

            // Create thumbnail if requested
            let thumbnailPath = null;
            if (createThumbnail) {
                thumbnailPath = path.join(dirname, `${basename}_thumb.${format}`);
                await sharp(filePath)
                    .resize(thumbnailSize, thumbnailSize, {
                        fit: 'cover',
                        position: 'center'
                    })
                    .jpeg({ quality: 80 })
                    .png({ compressionLevel: 9 })
                    .webp({ quality: 80 })
                    .toFile(thumbnailPath);
            }

            // Remove original if processing was successful
            fs.unlinkSync(filePath);

            return {
                processedPath,
                thumbnailPath,
                originalSize: await this.getFileSize(filePath),
                processedSize: await this.getFileSize(processedPath)
            };

        } catch (error) {
            console.error('❌ Error processing image:', error.message);
            throw new Error(`Image processing failed: ${error.message}`);
        }
    }

    /**
     * Get file size
     */
    async getFileSize(filePath) {
        try {
            const stats = fs.statSync(filePath);
            return stats.size;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Clean up temporary files
     */
    async cleanupTempFiles(maxAge = 24 * 60 * 60 * 1000) { // 24 hours
        try {
            const tempDir = path.join(this.uploadsDir, 'temp');
            const files = fs.readdirSync(tempDir);
            const now = Date.now();

            for (const file of files) {
                const filePath = path.join(tempDir, file);
                const stats = fs.statSync(filePath);

                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Cleaned up temp file: ${file}`);
                }
            }
        } catch (error) {
            console.error('❌ Error cleaning temp files:', error.message);
        }
    }

    /**
     * Validate file and return metadata
     */
    async validateAndGetMetadata(file) {
        try {
            const stats = fs.statSync(file.path);
            const ext = path.extname(file.filename).toLowerCase();

            let metadata = {
                filename: file.filename,
                originalName: file.originalname,
                mimetype: file.mimetype,
                size: stats.size,
                uploadDate: new Date(),
                category: this.getFileCategory(file.filename),
                isImage: this.allowedImageTypes.includes(ext)
            };

            // Get image metadata if it's an image
            if (metadata.isImage) {
                try {
                    const imageInfo = await sharp(file.path).metadata();
                    metadata.imageInfo = {
                        width: imageInfo.width,
                        height: imageInfo.height,
                        format: imageInfo.format,
                        hasAlpha: imageInfo.hasAlpha,
                        colorSpace: imageInfo.space
                    };
                } catch (error) {
                    console.warn('⚠️ Could not read image metadata:', error.message);
                }
            }

            return metadata;
        } catch (error) {
            throw new Error(`File validation failed: ${error.message}`);
        }
    }

    /**
     * Express middleware for handling upload errors
     */
    errorHandler(error, req, res, next) {
        if (error instanceof multer.MulterError) {
            switch (error.code) {
                case 'LIMIT_FILE_SIZE':
                    return res.status(400).json({
                        error: 'File too large',
                        message: `Maximum file size is ${this.maxFileSize / (1024 * 1024)}MB`
                    });
                case 'LIMIT_FILE_COUNT':
                    return res.status(400).json({
                        error: 'Too many files',
                        message: 'Maximum number of files exceeded'
                    });
                case 'LIMIT_UNEXPECTED_FILE':
                    return res.status(400).json({
                        error: 'Unexpected field',
                        message: 'Unexpected file field in upload'
                    });
                default:
                    return res.status(400).json({
                        error: 'Upload error',
                        message: error.message
                    });
            }
        }

        if (error.message.includes('not allowed') || error.message.includes('not supported')) {
            return res.status(400).json({
                error: 'Invalid file type',
                message: error.message
            });
        }

        next(error);
    }
}

// Create singleton instance
const fileHandler = new FileUploadHandler();

// Export middleware and utilities
module.exports = {
    single: (fieldName) => fileHandler.single(fieldName),
    multiple: (fieldName, maxCount) => fileHandler.multiple(fieldName, maxCount),
    processImage: (filePath, options) => fileHandler.processImage(filePath, options),
    validateAndGetMetadata: (file) => fileHandler.validateAndGetMetadata(file),
    cleanupTempFiles: () => fileHandler.cleanupTempFiles(),
    errorHandler: (error, req, res, next) => fileHandler.errorHandler(error, req, res, next),
    uploadsDir: fileHandler.uploadsDir
};