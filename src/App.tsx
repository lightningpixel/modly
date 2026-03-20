import { useEffect, useState } from 'react'
import { useAppStore } from '@shared/stores/appStore'
import FirstRunSetup from '@areas/setup/FirstRunSetup'
import MainLayout from '@shared/components/layout/MainLayout'
import { UpdateModal } from '@shared/components/ui/UpdateModal'
import { ErrorModal } from '@shared/components/ui/ErrorModal'

function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1
  }
  return 0
}

export default function App(): JSX.Element {
  const { checkSetup, setupStatus, initApp, backendStatus, showError } = useAppStore()
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string>('')

  useEffect(() => {
    checkSetup()
    window.electron.app.onError((message) => showError(message))

return () => { window.electron.app.offError() }
  }, [])

  useEffect(() => {
    if (setupStatus === 'done') initApp()
  }, [setupStatus])

  useEffect(() => {
    if (backendStatus !== 'ready') return
    window.electron.app.info().then(({ version }) => {
      setCurrentVersion(version)
      fetch('https://api.github.com/repos/lightningpixel/modly/releases/latest')
        .then((r) => r.json())
        .then((data) => {
          const latest = data?.tag_name as string | undefined
          if (latest && compareSemver(latest, version) > 0) setUpdateVersion(latest)
        })
        .catch(() => {})
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
