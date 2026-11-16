from pathlib import Path
p=Path(__file__).resolve().parents[1]
html=p/'index.html'
s=html.read_text()
start='/* BEGIN ASTRA DELIVERY EXTENSION */'
end='/* END ASTRA DELIVERY EXTENSION */'
block=start+'\n'+(p/'src/delivery.js').read_text()+'\n'+(p/'src/jobs.js').read_text()+'\n'+(p/'src/production.js').read_text()+''.join('\n'+(p/('src/'+name+'.js')).read_text() for name in ['llm','analysis','pipeline','pipeline-ui'])+'\n'+end
if start in s:
 a=s.index(start);b=s.index(end,a)+len(end);s=s[:a]+block+s[b:]
else:
 # React mounts asynchronously after all module declarations finish.
 point=s.index('</script>')
 s=s[:point]+block+'\nasDelivery.ready=asDeliveryInit();asJobsInit();asProductionInit();asPipelineInit();\n'+s[point:]
html.write_text(s)
