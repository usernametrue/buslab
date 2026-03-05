const fs = require('fs');
const path = require('path');

class I18n {
    constructor() {
        this.locales = {};
        this.defaultLocale = 'ru';
        this.fallbackLocale = 'ru';
        this.loadLocales();
    }

    loadLocales() {
        const localesDir = path.join(__dirname, 'locales');

        // Check if locales directory exists
        if (!fs.existsSync(localesDir)) {
            console.warn('Locales directory not found, creating it...');
            fs.mkdirSync(localesDir, { recursive: true });
            return;
        }

        const files = fs.readdirSync(localesDir);

        files.forEach(file => {
            if (file.endsWith('.json')) {
                const locale = file.replace('.json', '');
                const filePath = path.join(localesDir, file);
                try {
                    this.locales[locale] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    console.log(`Loaded locale: ${locale}`);
                } catch (error) {
                    console.error(`Error loading locale ${locale}:`, error.message);
                }
            }
        });
    }

    t(key, locale = this.defaultLocale, interpolations = {}) {
        const messages = this.locales[locale] || this.locales[this.fallbackLocale];
        const value = this.getNestedValue(messages, key);

        if (!value) {
            console.warn(`Translation missing: ${key} for locale: ${locale}`);
            return key; // Return key as fallback
        }

        return this.interpolate(value, interpolations);
    }

    getNestedValue(obj, key) {
        return key.split('.').reduce((current, segment) => {
            return current && current[segment];
        }, obj);
    }

    interpolate(template, values) {
        return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
            return values[key] !== undefined ? values[key] : match;
        });
    }

    getSupportedLocales() {
        return Object.keys(this.locales);
    }

    isLocaleSupported(locale) {
        return this.locales.hasOwnProperty(locale);
    }
}

module.exports = new I18n();