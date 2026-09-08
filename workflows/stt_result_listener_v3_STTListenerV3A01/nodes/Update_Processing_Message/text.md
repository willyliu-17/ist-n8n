={{ $('Guard Side Effect Owner').first().json.status === 'completed' ? '🤖 STT Done' : `🤖 STT ${$('Guard Side Effect Owner').first().json.status === 'timed_out' ? 'Timed Out' : 'Failed'}` }}
Stream: `{{ $('Guard Side Effect Owner').first().json.streamID }}`
Mode: `{{ $('Guard Side Effect Owner').first().json.mode }}` {{ $('Guard Side Effect Owner').first().json.durationMinutes }}m
