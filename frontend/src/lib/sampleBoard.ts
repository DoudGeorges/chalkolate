/**
 * Renders a synthetic lecture chalkboard frame containing intentional math, unit,
 * and spelling errors so Demo Mode uses the exact real capture and analysis pipeline.
 */
export async function renderSampleBoardBlob(): Promise<Blob> {
  const width = 1280
  const height = 720
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable for generating the sample board.')
  }

  // Dark slate-green chalkboard surface with subtle border
  const grad = ctx.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, '#182b23')
  grad.addColorStop(1, '#11201a')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, width, height)

  ctx.strokeStyle = '#6b4f35'
  ctx.lineWidth = 18
  ctx.strokeRect(9, 9, width - 18, height - 18)

  ctx.fillStyle = '#e7ece8'
  ctx.font = 'bold 34px Georgia, serif'
  ctx.fillText('PHYS 101 — Lecture 4: Kinematics & Integration', 64, 88)

  ctx.strokeStyle = 'rgba(231, 236, 232, 0.35)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(64, 110)
  ctx.lineTo(1200, 110)
  ctx.stroke()

  // 1. Intentional spelling mistakes
  ctx.fillStyle = '#f8fafc'
  ctx.font = '32px "Trebuchet MS", sans-serif'
  ctx.fillText('1. Newtons Second Law:  Acceleraton = Force / Mas', 72, 195)

  // 2. Intentional physics unit mistake
  ctx.fillStyle = '#fde68a'
  ctx.font = '32px "Trebuchet MS", sans-serif'
  ctx.fillText('2. Given m = 5 kg and a = 2 m/s^2:', 72, 295)
  ctx.fillText('   F = m * a = 10 N/m', 105, 350)

  // 3. Intentional algebra / calculus mistakes
  ctx.fillStyle = '#bae6fd'
  ctx.font = '32px "Trebuchet MS", sans-serif'
  ctx.fillText('3. Algebra reminder:  (a + b)^2 = a^2 + b^2', 72, 460)
  ctx.fillText('4. Derivative check:  d/dx (x^3) = 2x^2', 72, 555)

  ctx.fillStyle = 'rgba(226, 232, 240, 0.55)'
  ctx.font = '20px monospace'
  ctx.fillText('Synthetic sample frame — analyzed through normal /api/analyze pipeline', 72, 656)

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((res) => resolve(res), 'image/png')
  })
  if (!blob || blob.size === 0) {
    throw new Error('Failed to generate sample chalkboard image.')
  }
  return blob
}
