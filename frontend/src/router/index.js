import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import i18n from '@/utils/i18n' // Import the i18n instance

// Import views
// ...

const routes = []

const router = createRouter({
    history: createWebHistory(),
    routes,
    scrollBehavior(to, from, savedPosition) {
        if (savedPosition) {
            return savedPosition
        } else if (to.hash) {
            return { el: to.hash, behavior: 'smooth' }
        } else {
            return { top: 0, behavior: 'smooth' }
        }
    }
})

// Helper function to update meta description
function updateMetaDescription(description) {
    if (!description) return

    let metaDescription = document.querySelector('meta[name="description"]')
    if (metaDescription) {
        metaDescription.content = description
    } else {
        metaDescription = document.createElement('meta')
        metaDescription.name = 'description'
        metaDescription.content = description
        document.head.appendChild(metaDescription)
    }
}

// Navigation guards
router.beforeEach(async (to, from, next) => {
    // Wait for i18n to be ready
    try {
        await i18n.global.$waitForI18n?.() || Promise.resolve()
    } catch (error) {
        console.warn('Router: i18n not ready, using fallback titles')
    }

    // Update page title and description
    updatePageTitleAndDescription(to)

    // Check authentication
    const authStore = useAuthStore()
    if (to.meta.requiresAuth && !authStore.isAuthenticated) {
        next({ name: 'Landing', query: { redirect: to.fullPath } })
    } else {
        next()
    }
})

// Function to update page title and description
function updatePageTitleAndDescription(route) {
    // Set page title
    if (route.meta.titleKey) {
        try {
            const title = i18n.global.t(route.meta.titleKey)
            if (title && title !== route.meta.titleKey) {
                document.title = `${title} | ...`
            } else {
                // Fallback if translation not found
                document.title = '...'
            }
        } catch (error) {
            console.warn('Router: Error setting title:', error)
            document.title = '...'
        }
    } else {
        // Default title
        document.title = '...'
    }

    // Set meta description
    if (route.meta.descriptionKey) {
        try {
            const description = i18n.global.t(route.meta.descriptionKey)
            if (description && description !== route.meta.descriptionKey) {
                updateMetaDescription(description)
            }
        } catch (error) {
            console.warn('Router: Error setting description:', error)
        }
    }
}

// Watch for locale changes and update current page title
let localeWatcher = null
router.afterEach((to) => {
    // Set up locale watcher only once
    if (!localeWatcher) {
        localeWatcher = i18n.global.locale

        // Use Vue's watch if available, otherwise use a simple approach
        if (typeof window !== 'undefined' && window.Vue?.watch) {
            window.Vue.watch(() => i18n.global.locale.value, (newLocale, oldLocale) => {
                updatePageTitleAndDescription(router.currentRoute.value)
            })
        } else {
            // Fallback: check for locale changes periodically
            let lastLocale = i18n.global.locale.value
            setInterval(() => {
                const currentLocale = i18n.global.locale.value
                if (currentLocale !== lastLocale) {
                    updatePageTitleAndDescription(router.currentRoute.value)
                    lastLocale = currentLocale
                }
            }, 100) // Check every 100ms
        }
    }
})

// Make router globally accessible for i18n utility
if (typeof window !== 'undefined') {
    window.__VUE_ROUTER__ = router
}

export default router