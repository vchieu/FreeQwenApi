// Example of using OpenAI SDK with system message
// Installation: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Not used but required for SDK
});

async function systemMessageExample() {
    try {
        console.log('Sending request with system message to Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert astronomer specializing in the Solar System. Answer scientifically but in an understandable language.'
                },
                {
                    role: 'user',
                    content: 'Tell me about Mars and its features'
                }
            ],
            model: 'qwen-max-latest',
        });

        console.log('Response from Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nRequest with system message successfully completed.');

    } catch (error) {
        console.error('Error executing request:', error);
    }
}

// Run
systemMessageExample();
