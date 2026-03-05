#!/usr/bin/env node

/**
 * Application Metrics Exporter
 * Simple Prometheus-style metrics for application monitoring
 */

const http = require('http');
const { performance } = require('perf_hooks');

class MetricsExporter {
    constructor() {
        this.port = process.env.METRICS_PORT || 9090;
        this.metrics = new Map();
        this.startTime = Date.now();
        this.processStartTime = performance.now();

        // Initialize metrics
        this.initializeMetrics();

        // Start metrics collection
        this.collectMetrics();

        // Start HTTP server
        this.startServer();
    }

    /**
     * Initialize base metrics
     */
    initializeMetrics() {
        this.metrics.set('app_info', {
            type: 'gauge',
            help: 'Application information',
            value: 1,
            labels: {
                version: process.env.npm_package_version || '1.0.0',
                node_version: process.version,
                env: process.env.NODE_ENV || 'production'
            }
        });

        this.metrics.set('app_uptime_seconds', {
            type: 'gauge',
            help: 'Application uptime in seconds',
            value: 0
        });

        this.metrics.set('nodejs_memory_usage_bytes', {
            type: 'gauge',
            help: 'Node.js memory usage in bytes',
            value: 0,
            labels: { type: 'total' }
        });

        this.metrics.set('nodejs_cpu_usage_percent', {
            type: 'gauge',
            help: 'Node.js CPU usage percentage',
            value: 0
        });

        this.metrics.set('app_database_status', {
            type: 'gauge',
            help: 'Database connection status (1=connected, 0=disconnected)',
            value: 0
        });

        this.metrics.set('app_redis_status', {
            type: 'gauge',
            help: 'Redis connection status (1=connected, 0=disconnected)',
            value: 0
        });
    }

    /**
     * Collect system metrics
     */
    collectMetrics() {
        setInterval(() => {
            // Update uptime
            this.metrics.get('app_uptime_seconds').value = Math.floor((Date.now() - this.startTime) / 1000);

            // Update memory usage
            const memUsage = process.memoryUsage();
            this.metrics.set('nodejs_memory_usage_bytes', {
                type: 'gauge',
                help: 'Node.js memory usage in bytes',
                values: [
                    { value: memUsage.rss, labels: { type: 'rss' } },
                    { value: memUsage.heapUsed, labels: { type: 'heap_used' } },
                    { value: memUsage.heapTotal, labels: { type: 'heap_total' } },
                    { value: memUsage.external, labels: { type: 'external' } }
                ]
            });

            // Update CPU usage (simple approximation)
            const cpuUsage = process.cpuUsage();
            const totalCPU = cpuUsage.user + cpuUsage.system;
            this.metrics.get('nodejs_cpu_usage_percent').value = totalCPU / 1000000; // Convert to percentage

            // Check database status
            this.checkDatabaseStatus();

            // Check Redis status
            this.checkRedisStatus();

        }, 10000); // Update every 10 seconds
    }

    /**
     * Check database connection status
     */
    async checkDatabaseStatus() {
        try {
            if (process.env.ENABLE_MONGODB !== 'false') {
                const db = require('../db');
                const result = await db.healthCheck();
                this.metrics.get('app_database_status').value = result.status === 'healthy' ? 1 : 0;
            } else {
                this.metrics.get('app_database_status').value = -1; // Disabled
            }
        } catch (error) {
            this.metrics.get('app_database_status').value = 0;
        }
    }

    /**
     * Check Redis connection status
     */
    async checkRedisStatus() {
        try {
            if (process.env.ENABLE_REDIS !== 'false') {
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

                this.metrics.get('app_redis_status').value = result === 'PONG' ? 1 : 0;
            } else {
                this.metrics.get('app_redis_status').value = -1; // Disabled
            }
        } catch (error) {
            this.metrics.get('app_redis_status').value = 0;
        }
    }

    /**
     * Format metrics in Prometheus format
     */
    formatPrometheusMetrics() {
        let output = '';

        for (const [name, metric] of this.metrics.entries()) {
            // Add help comment
            output += `# HELP ${name} ${metric.help}\n`;
            output += `# TYPE ${name} ${metric.type}\n`;

            if (metric.values) {
                // Multiple values with labels
                for (const valueObj of metric.values) {
                    const labels = this.formatLabels(valueObj.labels);
                    output += `${name}${labels} ${valueObj.value}\n`;
                }
            } else {
                // Single value
                const labels = this.formatLabels(metric.labels);
                output += `${name}${labels} ${metric.value}\n`;
            }

            output += '\n';
        }

        return output;
    }

    /**
     * Format labels for Prometheus
     */
    formatLabels(labels) {
        if (!labels || Object.keys(labels).length === 0) {
            return '';
        }

        const labelPairs = Object.entries(labels)
            .map(([key, value]) => `${key}="${value}"`)
            .join(',');

        return `{${labelPairs}}`;
    }

    /**
     * Start HTTP server for metrics endpoint
     */
    startServer() {
        const server = http.createServer((req, res) => {
            if (req.url === '/metrics' && req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8'
                });
                res.end(this.formatPrometheusMetrics());
            } else if (req.url === '/health' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'healthy',
                    uptime: Math.floor((Date.now() - this.startTime) / 1000),
                    timestamp: new Date().toISOString()
                }));
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found\n\nAvailable endpoints:\n/metrics - Prometheus metrics\n/health - Health check');
            }
        });

        server.listen(this.port, () => {
            console.log(`📊 Metrics server running on port ${this.port}`);
            console.log(`📈 Metrics endpoint: http://localhost:${this.port}/metrics`);
            console.log(`🏥 Health endpoint: http://localhost:${this.port}/health`);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => {
            console.log('🔄 Received SIGTERM, shutting down metrics server...');
            server.close(() => {
                console.log('✅ Metrics server closed');
                process.exit(0);
            });
        });

        process.on('SIGINT', () => {
            console.log('🔄 Received SIGINT, shutting down metrics server...');
            server.close(() => {
                console.log('✅ Metrics server closed');
                process.exit(0);
            });
        });
    }

    /**
     * Add custom metric
     */
    addMetric(name, type, help, value, labels = {}) {
        this.metrics.set(name, {
            type,
            help,
            value,
            labels
        });
    }

    /**
     * Update metric value
     */
    updateMetric(name, value, labels = {}) {
        const metric = this.metrics.get(name);
        if (metric) {
            if (labels && Object.keys(labels).length > 0) {
                metric.labels = { ...metric.labels, ...labels };
            }
            metric.value = value;
        }
    }

    /**
     * Increment counter metric
     */
    incrementCounter(name, value = 1, labels = {}) {
        const metric = this.metrics.get(name);
        if (metric) {
            metric.value += value;
            if (labels && Object.keys(labels).length > 0) {
                metric.labels = { ...metric.labels, ...labels };
            }
        }
    }
}

// Export for use as module
module.exports = MetricsExporter;

// Run if called directly
if (require.main === module) {
    console.log('🚀 Starting application metrics exporter...');
    new MetricsExporter();
}