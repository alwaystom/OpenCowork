import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Minus, Plus, RotateCcw, Search } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { cn } from '@renderer/lib/utils'
import { useCodeGraphStore, type CgEdge, type CgNode } from '@renderer/stores/codegraph-store'

// Self-contained code-graph canvas (plan/codex-graph/07 Tier 2): DOM nodes + an SVG
// edge overlay over a pan/zoom camera. Seeded by a symbol/node, expand-on-click pulls
// each node's neighbors (codegraph/query-neighbors) and radially lays out the new ones.
// Node boxes keep a fixed pixel size (readable at any zoom); only positions scale.

interface Placed {
  node: CgNode
  x: number
  y: number
}

interface Camera {
  scale: number
  x: number
  y: number
}

const NODE_W = 150
const NODE_H = 34
const MIN_SCALE = 0.15
const MAX_SCALE = 2.5
const RING_START = 210
const RING_GAP = 150
const NODE_GAP = 46 // min arc gap between node centers on a ring

// Node accent by kind — a small, theme-neutral categorical set.
const KIND_COLORS: Record<string, string> = {
  function: 'border-l-sky-500',
  method: 'border-l-sky-500',
  class: 'border-l-violet-500',
  interface: 'border-l-violet-400',
  type: 'border-l-violet-400',
  struct: 'border-l-violet-500',
  enum: 'border-l-amber-500',
  variable: 'border-l-emerald-500',
  constant: 'border-l-emerald-500',
  route: 'border-l-rose-500',
  component: 'border-l-pink-500',
  file: 'border-l-muted-foreground'
}

function edgePath(fromX: number, fromY: number, toX: number, toY: number): string {
  const dx = Math.abs(toX - fromX)
  const c = Math.max(30, dx * 0.4)
  return `M ${fromX} ${fromY} C ${fromX + c} ${fromY}, ${toX - c} ${toY}, ${toX} ${toY}`
}

function edgeKey(e: CgEdge): string {
  return `${e.source}|${e.target}|${e.kind}`
}

// Concentric-ring placement that never overlaps: fill an inner ring to its arc
// capacity, then step outward. Returns offsets around (0,0), inner rings first.
function radialPositions(count: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  let placed = 0
  let ring = 0
  while (placed < count) {
    const radius = RING_START + ring * RING_GAP
    const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / (NODE_W + NODE_GAP)))
    const n = Math.min(capacity, count - placed)
    for (let i = 0; i < n; i++) {
      const theta = (i / n) * Math.PI * 2 + ring * 0.6
      out.push({ x: Math.cos(theta) * radius, y: Math.sin(theta) * radius })
    }
    placed += n
    ring++
  }
  return out
}

export function CodeGraphGraphView({
  root,
  seed
}: {
  root: string
  seed: { node?: CgNode; symbol?: string } | null
}): React.JSX.Element {
  const { t } = useTranslation('layout')
  const queryNeighbors = useCodeGraphStore((s) => s.queryNeighbors)

  const containerRef = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<Record<string, Placed>>({})
  const [edges, setEdges] = useState<CgEdge[]>([])
  const [camera, setCamera] = useState<Camera>({ scale: 1, x: 0, y: 0 })
  const [loading, setLoading] = useState(false)
  const [depth, setDepth] = useState(1)
  const [searchText, setSearchText] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null)

  // Fit the camera so the whole node set is visible and centered.
  const fitToContent = useCallback((nodes: Placed[]) => {
    const el = containerRef.current
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    if (nodes.length === 0) {
      setCamera({ scale: 1, x: w / 2, y: h / 2 })
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x - NODE_W / 2)
      maxX = Math.max(maxX, n.x + NODE_W / 2)
      minY = Math.min(minY, n.y - NODE_H / 2)
      maxY = Math.max(maxY, n.y + NODE_H / 2)
    }
    const pad = 56
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(w / (maxX - minX + pad * 2), h / (maxY - minY + pad * 2)))
    )
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    setCamera({ scale, x: w / 2 - cx * scale, y: h / 2 - cy * scale })
  }, [])

  // Seed the graph from a symbol name or a node.
  const seedGraph = useCallback(
    async (params: { node?: CgNode; symbol?: string }) => {
      setLoading(true)
      try {
        const sub = await queryNeighbors(root, {
          symbol: params.symbol ?? params.node?.name,
          nodeId: params.node?.id,
          depth,
          limit: 48
        })
        const rootId = sub.roots[0] ?? params.node?.id ?? sub.nodes[0]?.id
        const rootNode = sub.nodes.find((n) => n.id === rootId) ?? params.node
        const others = sub.nodes.filter((n) => n.id !== rootNode?.id)
        const next: Record<string, Placed> = {}
        if (rootNode) next[rootNode.id] = { node: rootNode, x: 0, y: 0 }
        const pos = radialPositions(others.length)
        others.forEach((n, i) => {
          next[n.id] = { node: n, x: pos[i].x, y: pos[i].y }
        })
        setPlaced(next)
        setEdges(sub.edges)
        setExpanded(new Set(rootNode ? [rootNode.id] : []))
        fitToContent(Object.values(next))
      } finally {
        setLoading(false)
      }
    },
    [queryNeighbors, root, depth, fitToContent]
  )

  useEffect(() => {
    if (seed && (seed.node || seed.symbol)) void seedGraph(seed)
    // Only re-seed when the seed identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed])

  const expandNode = useCallback(
    async (id: string) => {
      const origin = placed[id]
      if (!origin || expanded.has(id)) return
      setExpanded((prev) => new Set(prev).add(id))
      setLoading(true)
      try {
        const sub = await queryNeighbors(root, { nodeId: id, depth: 1, limit: 32 })
        const next = { ...placed }
        const fresh = sub.nodes.filter((n) => !next[n.id])
        const pos = radialPositions(fresh.length)
        fresh.forEach((n, i) => {
          next[n.id] = { node: n, x: origin.x + pos[i].x * 0.7, y: origin.y + pos[i].y * 0.7 }
        })
        const seen = new Set(edges.map(edgeKey))
        const mergedEdges = [...edges]
        for (const e of sub.edges) {
          if (!seen.has(edgeKey(e))) {
            seen.add(edgeKey(e))
            mergedEdges.push(e)
          }
        }
        setPlaced(next)
        setEdges(mergedEdges)
        fitToContent(Object.values(next))
      } finally {
        setLoading(false)
      }
    },
    [placed, edges, expanded, queryNeighbors, root, fitToContent]
  )

  // Pan.
  const onMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return
    panRef.current = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y }
  }
  const onMouseMove = (e: React.MouseEvent): void => {
    const pan = panRef.current
    if (!pan) return
    setCamera((c) => ({
      ...c,
      x: pan.camX + (e.clientX - pan.startX),
      y: pan.camY + (e.clientY - pan.startY)
    }))
  }
  const endPan = (): void => {
    panRef.current = null
  }

  // Zoom at cursor.
  const onWheel = (e: React.WheelEvent): void => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setCamera((c) => {
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor))
      const k = scale / c.scale
      return { scale, x: px - (px - c.x) * k, y: py - (py - c.y) * k }
    })
  }

  const zoomBy = (factor: number): void => {
    const el = containerRef.current
    const w = el?.clientWidth ?? 800
    const h = el?.clientHeight ?? 600
    setCamera((c) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, c.scale * factor))
      const k = scale / c.scale
      return { scale, x: w / 2 - (w / 2 - c.x) * k, y: h / 2 - (h / 2 - c.y) * k }
    })
  }

  const submitSearch = (): void => {
    const q = searchText.trim()
    if (q) void seedGraph({ symbol: q })
  }

  const nodeList = Object.values(placed)
  const hasGraph = nodeList.length > 0

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitSearch()
            }}
            placeholder={t('codegraphPage.graph.searchPlaceholder')}
            className="w-full rounded-md border bg-background py-1.5 pl-7 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {t('codegraphPage.graph.depth')}
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="rounded border bg-background px-1 py-0.5 text-xs"
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <div className="flex-1" />
        {hasGraph ? (
          <span className="text-[11px] text-muted-foreground">
            {t('codegraphPage.graph.nodesEdges', { nodes: nodeList.length, edges: edges.length })}
          </span>
        ) : null}
        {loading ? <Spinner className="size-4 text-muted-foreground" /> : null}
        <Button variant="outline" size="icon" className="size-7" onClick={() => zoomBy(1.1)}>
          <Plus className="size-3.5" />
        </Button>
        <Button variant="outline" size="icon" className="size-7" onClick={() => zoomBy(1 / 1.1)}>
          <Minus className="size-3.5" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-7"
          onClick={() => hasGraph && fitToContent(nodeList)}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endPan}
        onMouseLeave={endPan}
        onWheel={onWheel}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-muted/10 active:cursor-grabbing"
      >
        {!hasGraph ? (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              {loading ? t('codegraphPage.graph.loading') : t('codegraphPage.graph.seedHint')}
            </p>
          </div>
        ) : (
          <>
            {/* Edges */}
            <svg className="pointer-events-none absolute inset-0 h-full w-full">
              {edges.map((e) => {
                const a = placed[e.source]
                const b = placed[e.target]
                if (!a || !b) return null
                const ax = a.x * camera.scale + camera.x
                const ay = a.y * camera.scale + camera.y
                const bx = b.x * camera.scale + camera.x
                const by = b.y * camera.scale + camera.y
                const heuristic = e.provenance === 'heuristic'
                return (
                  <path
                    key={edgeKey(e)}
                    d={edgePath(ax, ay, bx, by)}
                    fill="none"
                    stroke="#898781"
                    strokeOpacity={0.55}
                    strokeWidth={1.5}
                    strokeDasharray={heuristic ? '4 3' : undefined}
                  />
                )
              })}
            </svg>

            {/* Nodes */}
            {nodeList.map(({ node, x, y }) => {
              const sx = x * camera.scale + camera.x
              const sy = y * camera.scale + camera.y
              const accent = KIND_COLORS[node.kind] ?? 'border-l-muted-foreground'
              return (
                <button
                  key={node.id}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void expandNode(node.id)}
                  title={`${node.kind} · ${node.filePath}:${node.startLine}`}
                  style={{
                    left: sx - NODE_W / 2,
                    top: sy - NODE_H / 2,
                    width: NODE_W,
                    height: NODE_H
                  }}
                  className={cn(
                    'absolute flex flex-col justify-center overflow-hidden rounded-md border border-l-4 bg-card px-2 text-left shadow-sm transition-colors hover:border-primary hover:bg-accent',
                    accent,
                    expanded.has(node.id) && 'ring-1 ring-primary/40'
                  )}
                >
                  <span className="truncate text-[11px] font-medium leading-tight">
                    {node.name}
                  </span>
                  <span className="truncate text-[9px] text-muted-foreground leading-tight">
                    {node.kind}
                  </span>
                </button>
              )
            })}
          </>
        )}
      </div>
    </div>
  )
}
