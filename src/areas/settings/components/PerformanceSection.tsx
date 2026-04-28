import { useState } from 'react'
import { Section, Card, Row, Select, Toggle } from '@shared/ui'

export function PerformanceSection(): JSX.Element {
  const [gpu,     setGpu]     = useState('auto')
  const [vram,    setVram]    = useState('8')
  const [workers, setWorkers] = useState('1')
  const [fp16,    setFp16]    = useState(true)

  return (
    <Section title="Performance" subtitle="Configure GPU usage and memory limits.">
      <div className="grid grid-cols-2 gap-4">

        <Card title="Device" description="Select which compute device to use for AI inference.">
          <Row label="GPU device" description="Device used for model inference.">
            <Select value={gpu} onChange={setGpu} options={[
              { value: 'auto',  label: 'Auto-detect' },
              { value: 'mps',   label: 'Apple GPU (MPS)' },
              { value: 'cuda0', label: 'NVIDIA GPU 0' },
              { value: 'cuda1', label: 'NVIDIA GPU 1' },
              { value: 'cpu',   label: 'CPU (slow)' },
            ]} />
          </Row>
          <Row label="FP16 precision" description="Half-precision for faster inference.">
            <Toggle value={fp16} onChange={setFp16} />
          </Row>
        </Card>

        <Card title="Memory" description="Control memory allocation per generation job.">
          <Row label="VRAM limit" description="Max GPU memory per generation.">
            <Select value={vram} onChange={setVram} options={[
              { value: '4',  label: '4 GB' },
              { value: '6',  label: '6 GB' },
              { value: '8',  label: '8 GB' },
              { value: '12', label: '12 GB' },
              { value: '0',  label: 'No limit' },
            ]} />
          </Row>
          <Row label="Parallel workers" description="Concurrent generation jobs.">
            <Select value={workers} onChange={setWorkers} options={[
              { value: '1', label: '1 (default)' },
              { value: '2', label: '2' },
              { value: '4', label: '4' },
            ]} />
          </Row>
        </Card>

      </div>
    </Section>
  )
}
