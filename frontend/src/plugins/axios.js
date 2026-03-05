import axios from 'axios'

// Create axios instance with default configuration
const apiClient = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api',
    withCredentials: true,
    timeout: 30000, // 30 seconds timeout
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
})

// Request interceptor
apiClient.interceptors.request.use(
    (config) => {
        // Add auth token if available
        const token = localStorage.getItem('accessToken')
        if (token) {
            config.headers.Authorization = `Bearer ${token}`
        }

        // Log request in development
        if (import.meta.env.DEV) {
            console.log('API Request:', config.method?.toUpperCase(), config.url)
        }

        return config
    },
    (error) => {
        console.error('Request error:', error)
        return Promise.reject(error)
    }
)

// Response interceptor
apiClient.interceptors.response.use(
    (response) => {
        // Log response in development
        if (import.meta.env.DEV) {
            console.log('API Response:', response.status, response.config.url)
        }

        return response
    },
    async (error) => {
        const originalRequest = error.config

        // Handle 401 errors (unauthorized)
        if (error.response?.status === 401 && !originalRequest._retry) {
            originalRequest._retry = true

            try {
                // Try to refresh token
                const refreshToken = localStorage.getItem('refreshToken')
                if (refreshToken) {
                    const response = await axios.post('/api/auth/refresh', {
                        refreshToken
                    })

                    const { accessToken } = response.data
                    localStorage.setItem('accessToken', accessToken)

                    // Retry original request with new token
                    originalRequest.headers.Authorization = `Bearer ${accessToken}`
                    return apiClient(originalRequest)
                }
            } catch (refreshError) {
                // Refresh failed, redirect to login
                console.error('Token refresh failed:', refreshError)
                localStorage.removeItem('accessToken')
                localStorage.removeItem('refreshToken')
                localStorage.removeItem('user')

                // Redirect to login page
                window.location.href = '/'
            }
        }

        // Handle network errors
        if (error.code === 'NETWORK_ERROR' || error.code === 'ECONNABORTED') {
            console.error('Network error:', error.message)
            // You can show a global network error message here
        }

        // Log error in development
        if (import.meta.env.DEV) {
            console.error('API Error:', error.response?.status, error.config?.url, error.message)
        }

        return Promise.reject(error)
    }
)

// Vue plugin installation function
export default {
    install(app) {
        // Make axios available globally as $http
        app.config.globalProperties.$http = apiClient

        // Make axios available via provide/inject
        app.provide('$http', apiClient)
    }
}

// Export the configured axios instance for direct use
export { apiClient }