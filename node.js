        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            connectionStatus = 'disconnected';
            io.emit('status', { status: 'disconnected' });
            console.log(`❌ انقطع الاتصال (السبب: ${statusCode || 'غير معروف'})`);
            
            // إذا كان الخطأ 405 أو مشكلة في الجلسة، نمسح الملفات القديمة ونعيد التوليد
            if (statusCode === 405 || statusCode === 401) {
                console.log('🧹 تم اكتشاف تعارض في الجلسة (405)، جاري مسح الجلسة القديمة لتوليد باركود جديد...');
                const fs = require('fs');
                if (fs.existsSync('auth_info')) {
                    fs.rmSync('auth_info', { recursive: true, force: true });
                }
            }

            if (shouldReconnect || statusCode === 405) {
                console.log('🔄 جاري إعادة محاولة الاتصال وتوليد QR جديد...');
                setTimeout(startBot, 3000);
            } else {
                console.log('⚠️ تم تسجيل الخروج نهائياً.');
            }
        }
