import { useEffect, useLayoutEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import FirstRunSetup from '@areas/setup/FirstRunSetup'
import MainLayout from '@shared/components/layout/MainLayout'
import { UpdateModal } from '@shared/components/ui/UpdateModal'
import { ErrorModal } from '@shared/components/ui/ErrorModal'
import { Toast } from '@shared/components/ui/Toast'


export default function App(): JSX.Element {
  const { checkSetup, setupStatus, initApp, backendStatus, showError, useAtkinsonFont,
          uiZoomFactor, setUiZoomFactor } = useAppStore()
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
    window.electron.ui.setZoomFactor(uiZoomFactor)
  }, [useAtkinsonFont, uiZoomFactor])

  // Ctrl/Cmd +/-/0 is caught by the main process, because Chromium claims those
  // chords before the page sees them. It only tells us WHICH way to go — the
  // size itself lives here, in the one place that is saved and re-applied on
  // launch. Keeping a second copy in the main process is what used to lose the
  // setting on every restart: it restored the saved zoom, then this component
  // mounted and overwrote it.
  useEffect(() => {
    window.electron.ui.onZoomStep((step) => {
      if (step === 0) setUiZoomFactor(1)
      else setUiZoomFactor(Number((useAppStore.getState().uiZoomFactor + step * 0.1).toFixed(2)))
    })
    return () => window.electron.ui.offZoomStep()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store actions are stable
  }, [])

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
