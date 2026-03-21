import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import FirstRunSetup from '@areas/setup/FirstRunSetup'
import MainLayout from '@shared/components/layout/MainLayout'
import { UpdateModal } from '@shared/components/ui/UpdateModal'
import { ErrorModal } from '@shared/components/ui/ErrorModal'

export default function App(): JSX.Element {
  const { checkSetup, setupStatus, initApp, backendStatus, showError, setPatchUpdateReady } = useAppStore()
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string>('')

  useEffect(() => {
    checkSetup()
    window.electron.app.onError((message) => showError(message))
    window.electron.updater.onPatchReady(() => {
      setPatchUpdateReady(true)
    })
    window.electron.updater.onMajorMinorAvailable(({ version }) => {
      setUpdateVersion(`v${version}`)
    })
    return () => {
      window.electron.app.offError()
      window.electron.updater.offPatchReady()
      window.electron.updater.offMajorMinorAvailable()
    }
  }, [])

  useEffect(() => {
    if (setupStatus === 'done') initApp()
  }, [setupStatus])

  useEffect(() => {
    if (backendStatus !== 'ready') return
    window.electron.app.info().then(({ version }) => {
      setCurrentVersion(version)
      window.electron.updater.check()
    })
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
      <ErrorModal />
    </>
  )
  return (
    <>
      <FirstRunSetup />
      <ErrorModal />
    </>
  )
}
