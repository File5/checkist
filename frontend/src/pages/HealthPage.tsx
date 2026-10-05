import { useEffect, useRef, useState } from 'react'
import { getHealth } from '../api/health'
import type { CheckCode, HealthErrorReason, HealthResult, ServiceCheck } from '../api/health'

type PageState = { kind: 'loading' } | HealthResult

const checkMessages: Record<CheckCode, string> = {
  database_unavailable: 'База данных недоступна',
  redis_unavailable: 'Кеш недоступен',
  broker_unavailable: 'Очередь задач недоступна',
  worker_unavailable: 'Обработчик задач не отвечает',
}

const errorMessages: Record<HealthErrorReason, string> = {
  network: 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.',
  timeout: 'Сервер не ответил за 15 секунд. Повторите попытку.',
  cancelled: 'Проверка отменена. Повторите попытку.',
  server: 'На сервере произошла ошибка. Повторите попытку позже.',
  http: 'Сервер не смог выполнить проверку. Повторите попытку позже.',
  'invalid-json': 'Сервер вернул нечитаемый ответ. Повторите попытку позже.',
  'invalid-schema': 'Ответ сервера имеет неожиданный формат. Повторите попытку позже.',
  'inconsistent-response': 'Сервер вернул несогласованный ответ. Повторите попытку позже.',
}

function serviceStatus(state: PageState, check?: ServiceCheck) {
  if (state.kind === 'loading') return { tone: 'pending', text: 'Проверяем…' }
  if (!check) return { tone: 'unknown', text: 'Не удалось проверить' }
  if (check.status === 'error') return { tone: 'error', text: checkMessages[check.code] }
  return { tone: 'ok', text: 'Доступен' }
}

export default function HealthPage() {
  const [state, setState] = useState<PageState>({ kind: 'loading' })
  const [request, setRequest] = useState(0)
  const activeController = useRef<AbortController | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    activeController.current = controller
    const currentGeneration = ++generation.current

    void getHealth({ signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted && generation.current === currentGeneration) {
        setState(result)
      }
    })

    return () => controller.abort()
  }, [request])

  const repeat = () => {
    activeController.current?.abort()
    setState({ kind: 'loading' })
    setRequest((previous) => previous + 1)
  }

  const loading = state.kind === 'loading'
  const title = loading ? 'Проверяем соединение…'
    : state.kind === 'ok' ? 'Соединение установлено'
      : state.kind === 'degraded' ? 'Некоторые сервисы недоступны'
        : 'Не удалось проверить соединение'
  const detail = state.kind === 'error' ? errorMessages[state.reason]
    : state.kind === 'degraded' ? 'Сервер отвечает, но часть сервисов требует внимания.'
      : state.kind === 'ok' ? 'Сервер и все три сервиса доступны.'
        : 'Запрашиваем текущее состояние сервера и сервисов.'
  const checks = state.kind === 'ok' || state.kind === 'degraded' ? state.checks : undefined
  const apiStatus = {
    tone: loading ? 'pending' : state.kind === 'error' ? 'error' : 'ok',
    text: loading ? 'Проверяем…' : state.kind === 'error' ? 'Проверка не удалась' : 'Отвечает',
  }
  const services = [
    { name: 'API', description: 'Соединение с сервером', ...apiStatus },
    { name: 'База данных', description: 'Хранение данных', ...serviceStatus(state, checks?.database) },
    { name: 'Redis', description: 'Кеш', ...serviceStatus(state, checks?.redis) },
    { name: 'Celery', description: 'Обработка задач', ...serviceStatus(state, checks?.celery) },
  ]

  return (
    <>
      <section className="health-panel" aria-labelledby="health-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Состояние системы</p>
            <h2 id="health-heading">Связь с сервисами</h2>
          </div>
          <button type="button" onClick={repeat} disabled={loading}>Повторить</button>
        </div>

        <div className={`health-summary summary-${state.kind}`} role="status" aria-live="polite" aria-atomic="true">
          <span className="summary-dot" aria-hidden="true" />
          <div>
            <p className="summary-title">{title}</p>
            <p className="summary-detail">{detail}</p>
          </div>
        </div>

        <dl className="services" aria-busy={loading}>
          {services.map((service) => (
            <div className="service" key={service.name}>
              <dt><span className="service-name">{service.name}</span><span className="service-description">{service.description}</span></dt>
              <dd className={`service-state tone-${service.tone}`}><span className="status-dot" aria-hidden="true" />{service.text}</dd>
            </div>
          ))}
        </dl>
        <p className="panel-note">Статусы обновляются при открытии страницы и по кнопке «Повторить».</p>
      </section>

      <section className="planned" aria-labelledby="planned-heading">
        <p className="eyebrow">Следующие этапы</p>
        <h2 id="planned-heading">Что планируется</h2>
        <ul>
          <li>Ручное исправление распознанных данных</li>
          <li>Пользовательский вход и доступ к своим чекам</li>
          <li>Дашборд со статистикой</li>
        </ul>
        <p>Эти функции пока не реализованы.</p>
      </section>
    </>
  )
}
