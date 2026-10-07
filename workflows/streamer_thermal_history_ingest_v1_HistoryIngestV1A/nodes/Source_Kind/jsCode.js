return $input.all().map(i=>({json:{...i.json,_kind:i.json._watermark?'watermark':'source'}}));
