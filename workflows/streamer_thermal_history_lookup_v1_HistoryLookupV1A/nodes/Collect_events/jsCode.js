return [{json:{rows:$input.all().map(i=>i.json).filter(r=>r.id)}}];
