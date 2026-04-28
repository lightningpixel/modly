import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import FirstRunSetup from '@areas/setup/FirstRunSetup'
import MainLayout from '@shared/components/layout/MainLayout'
import { UpdateModal } from '@shared/components/ui/UpdateModal'
import { ErrorModal } from '@shared/components/ui/ErrorModal'
import { Toast } from '@shared/components/ui/Toast'

export default function App(): JSX.Element {
  const { checkSetup, setupStatus, initApp, backendStatus, showError } = useAppStore()
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
  }, [])

  useEffect(() => {
    if (setupStatus === 'done') initApp()
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
