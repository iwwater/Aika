import QRCode from 'qrcode';
/** Local PNG only; the installed bundle includes its reviewed runtime dependencies. */
export const qrImage = (content: string): Promise<string> => QRCode.toDataURL(content,{errorCorrectionLevel:'M',margin:3,width:256});
