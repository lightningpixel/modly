import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en/translation.json'
import es from './locales/es/translation.json'

const resources = {
  en: { translation: en },
  es: { translation: es },
}

i18n
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    lng: 'en', // Default to English, will be overridden by settings
    interpolation: {
      escapeValue: false, // React already escapes
    },
  })

export default i18n
