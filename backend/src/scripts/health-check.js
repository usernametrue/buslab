#!/usr/bin/env node

/**
 * Health Check Script
 * Monitors application status for Docker health checks and monitoring
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
    APP_PORT: process.env.PORT || 3000,
    DB_ENABLED: process.env.ENABLE_MONGODB !== 'false',
    REDIS_ENABLED: process.env.ENABLE_REDIS !== 'false',
    RABBITMQ_ENABLED: process.env.ENABLE_RABBITMQ !== 'false',
    TIMEOUT: 5000, // 5 seconds
    HEALTH_ENDPOINT: '/health'
};

// ANSI color codes for output
const colors = {
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    reset: '\x1b[0m'
};

class HealthChecker {
    constructor() {
        this.checks = [];
        this.results = {
            app: null,
            database: null,
            redis: null,
            rabbitmq: null,
            filesystem: null
        };
    }

    /**
     * Add colored output
     */
    log(message, color = 'reset') {
        if (process.env.NODE_ENV !== 'test') {
            console.log(`${colors[color]}${message}${colors.reset}`);
        }
    }

    /**
     * Check if application is responding
     */
    async checkApp() {
        return new Promise((resolve) => {
            const options = {
                hostname: 'localhost',
                port: CONFIG.APP_PORT,
                path: CONFIG.HEALTH_ENDPOINT,
                method: 'GET',
                timeout: CONFIG.TIMEOUT
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        resolve({ status: 'healthy', message: 'Application responding' });
                    } else {
                        resolve({ status: 'unhealthy', message: `HTTP ${res.statusCode}` });
                    }
                });
            });

            req.on('error', (error) => {
                resolve({ status: 'error', message: error.message });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ status: 'timeout', message: 'Request timeout' });
            });

            req.end();
        });
    }

    /**
     * Check database connection (if enabled)
     */
    async checkDatabase() {
        if (!CONFIG.DB_ENABLED) {
            return { status: 'disabled', message: 'Database check disabled' };
        }

        try {
            // Try to require the db module
            const db = require('../db');
            const result = await db.healthCheck();
            return result;
        } catch (error) {
            return { status: 'error', message: `Database check failed: ${error.message}` };
        }
    }

    /**
     * Check Redis connection (if enabled)
     */
    async checkRedis() {
        if (!CONFIG.REDIS_ENABLED) {
            return { status: 'disabled', message: 'Redis check disabled' };
        }

        try {
            const redis = require('redis');
            const client = redis.createClient({
                host: process.env.REDIS_HOST || 'redis',
                port: process.env.REDIS_PORT || 6379,
                password: process.env.REDIS_PASSWORD,
                connectTimeout: 3000,
                lazyConnect: true
            });

            await client.connect();
            const result = await client.ping();
            await client.quit();

            if (result === 'PONG') {
                return { status: 'healthy', message: 'Redis responding' };
            } else {
                return { status: 'unhealthy', message: 'Redis ping failed' };
            }
        } catch (error) {
            return { status: 'error', message: `Redis check failed: ${error.message}` };
        }
    }

    /**
     * Check RabbitMQ connection (if enabled)
     */
    async checkRabbitMQ() {
        if (!CONFIG.RABBITMQ_ENABLED) {
            return { status: 'disabled', message: 'RabbitMQ check disabled' };
        }

        try {
            const amqp = require('amqplib');
            const connection = await amqp.connect({
                hostname: process.env.RABBITMQ_HOST || 'rabbitmq',
                port: process.env.RABBITMQ_PORT || 5672,
                username: process.env.RABBITMQ_USER || 'guest',
                password: process.env.RABBITMQ_PASSWORD || 'guest',
                timeout: 3000
            });

            await connection.close();
            return { status: 'healthy', message: 'RabbitMQ responding' };
        } catch (error) {
            return { status: 'error', message: `RabbitMQ check failed: ${error.message}` };
        }
    }

    /**
     * Check filesystem (uploads directory)
     */
    async checkFilesystem() {
        try {
            const uploadsDir = process.env.UPLOADS_DIR || './uploads';

            // Check if directory exists
            if (!fs.existsSync(uploadsDir)) {
                return { status: 'error', message: 'Uploads directory not found' };
            }

            // Check if it's writable
            const testFile = path.join(uploadsDir, '.health-check');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);

            // Check if it's a symlink (NFS setup)
            const stats = fs.lstatSync(uploadsDir);
            const type = stats.isSymbolicLink() ? 'symlink (NFS)' : 'directory';

            return {
                status: 'healthy',
                message: `Filesystem accessible (${type})`,
                path: uploadsDir
            };
        } catch (error) {
            return { status: 'error', message: `Filesystem check failed: ${error.message}` };
        }
    }

    /**
     * Run all health checks
     */
    async runAllChecks() {
        this.log('🏥 Running health checks...', 'blue');

        // Run checks in parallel
        const [app, database, redis, rabbitmq, filesystem] = await Promise.all([
            this.checkApp(),
            this.checkDatabase(),
            this.checkRedis(),
            this.checkRabbitMQ(),
            this.checkFilesystem()
        ]);

        this.results = { app, database, redis, rabbitmq, filesystem };

        // Display results
        this.displayResults();

        // Return overall status
        return this.getOverallStatus();
    }

    /**
     * Display check results
     */
    displayResults() {
        this.log('\n📊 Health Check Results:', 'blue');
        this.log('========================', 'blue');

        for (const [service, result] of Object.entries(this.results)) {
            const icon = this.getStatusIcon(result.status);
            const color = this.getStatusColor(result.status);
            const serviceName = service.charAt(0).toUpperCase() + service.slice(1);

            this.log(`${icon} ${serviceName}: ${result.message}`, color);
        }

        this.log('========================\n', 'blue');
    }

    /**
     * Get status icon
     */
    getStatusIcon(status) {
        switch (status) {
            case 'healthy': return '✅';
            case 'unhealthy': return '⚠️';
            case 'error': return '❌';
            case 'disabled': return '⏸️';
            case 'timeout': return '⏰';
            default: return '❓';
        }
    }

    /**
     * Get status color
     */
    getStatusColor(status) {
        switch (status) {
            case 'healthy': return 'green';
            case 'unhealthy': return 'yellow';
            case 'error': return 'red';
            case 'disabled': return 'blue';
            case 'timeout': return 'yellow';
            default: return 'reset';
        }
    }

    /**
     * Get overall health status
     */
    getOverallStatus() {
        const criticalServices = ['app'];
        const enabledServices = Object.entries(this.results)
            .filter(([service, result]) => result.status !== 'disabled');

        // Check critical services
        for (const service of criticalServices) {
            if (this.results[service].status !== 'healthy') {
                return {
                    healthy: false,
                    status: 'critical',
                    message: `Critical service ${service} is not healthy`
                };
            }
        }

        // Check enabled services
        const unhealthyServices = enabledServices
            .filter(([service, result]) => result.status !== 'healthy')
            .map(([service]) => service);

        if (unhealthyServices.length > 0) {
            return {
                healthy: false,
                status: 'degraded',
                message: `Services ${unhealthyServices.join(', ')} are not healthy`
            };
        }

        return {
            healthy: true,
            status: 'healthy',
            message: 'All services are healthy'
        };
    }

    /**
     * Run checks and exit with appropriate code
     */
    async run() {
        try {
            const result = await this.runAllChecks();

            if (result.healthy) {
                this.log(`✅ ${result.message}`, 'green');
                process.exit(0);
            } else {
                this.log(`❌ ${result.message}`, 'red');
                process.exit(1);
            }
        } catch (error) {
            this.log(`💀 Health check failed: ${error.message}`, 'red');
            process.exit(1);
        }
    }
}

// Export for use as module
module.exports = HealthChecker;

// Run if called directly
if (require.main === module) {
    const checker = new HealthChecker();
    checker.run();
}