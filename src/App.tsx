import { useEffect, useLayoutEffect, useState } from 'react'
import { useAppStore, type UiScale } from '@shared/stores/appStore'
import FirstRunSetup from '@areas/setup/FirstRunSetup'
import MainLayout from '@shared/components/layout/MainLayout'
import { UpdateModal } from '@shared/components/ui/UpdateModal'
import { ErrorModal } from '@shared/components/ui/ErrorModal'
import { Toast } from '@shared/components/ui/Toast'

const UI_SCALE_FACTORS: Record<UiScale, number> = { small: 0.875, medium: 1, large: 1.25, 'very-large': 1.5 }

export default function App(): JSX.Element {
  const { checkSetup, setupStatus, initApp, backendStatus, showError, useAtkinsonFont, uiScale } = useAppStore()
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string>('')

  useEffect(() => {
    checkSetup()
    window.electron.app.onError((message) => showError(message))
    window.electron.updater.onMajorMinorAvailable(({ version }) => {
      setUpdateVersion(`v${version}`)
    })
    return () => {
      window.electron.app.offError()
      window.electron.updater.offMajorMinorAvailable()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; store actions are stable
  }, [])

  // Apply before paint to avoid a flash of default font/size on launch.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(
      '--app-font',
      useAtkinsonFont
        ? "'Atkinson Hyperlegible', system-ui, sans-serif"
        : "'Inter', system-ui, sans-serif"
    )
    window.electron.ui.setZoomFactor(UI_SCALE_FACTORS[uiScale])
  }, [useAtkinsonFont, uiScale])

  useEffect(() => {
    if (setupStatus === 'done') initApp()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to setup transition only; initApp is stable
  }, [setupStatus])

  useEffect(() => {
    if (backendStatus !== 'ready') return
    window.electron.app.info().then(({ version }) => setCurrentVersion(version))
  }, [backendStatus])

  if (backendStatus === 'ready') return (
    <>
      <MainLayout />
      {updateVersion && (
        <UpdateModal
          currentVersion={currentVersion}
          latestVersion={updateVersion}
          onDismiss={() => setUpdateVersion(null)}
        />
      )}
      <Toast />
      <ErrorModal />
    </>
  )
  return (
    <>
      <FirstRunSetup />
      <Toast />
      <ErrorModal />
    </>
  )
}
