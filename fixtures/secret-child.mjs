const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const secret = Buffer.concat(chunks).toString('utf8')
const argvHasSecret = process.argv.some(value => value.includes(secret))
const envHasSecret = Object.values(process.env).some(value => value?.includes(secret))
process.stdout.write(JSON.stringify({ argvHasSecret, envHasSecret, receivedBytes: Buffer.byteLength(secret) }) + '\n')
process.stderr.write(`simulated upstream failure contained ${secret}\n`)
