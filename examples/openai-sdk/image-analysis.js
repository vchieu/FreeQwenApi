// Example of using OpenAI SDK for image analysis
// Installation: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api',
    apiKey: 'dummy-key', // Not used but required for SDK
});

// IMPORTANT: Replace IMAGE_URL with a real image URL obtained from the Qwen web interface
// Instructions for getting URL in README.md, section "Getting image URL from Qwen web interface"
const IMAGE_URL = "https://cdn.qwenlm.ai/bf6238a3-4578-49d6-b4a9-516e8a5eb27b/c88bc915-6ae7-4057-9bf9-1185c9141a0a_image.png?key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXNvdXJjZV91c2VyX2lkIjoiYmY2MjM4YTMtNDU3OC00OWQ2LWI0YTktNTE2ZThhNWViMjdiIiwicmVzb3VyY2VfaWQiOiJjODhiYzkxNS02YWU3LTQwNTctOWJmOS0xMTg1YzkxNDFhMGEiLCJyZXNvdXJjZV9jaGF0X2lkIjpudWxsfQ.qPvHr4fq23IgzxmxOyFJuFcVL0AJlpGgPlWB8BHkrlo";

async function analyzeImage() {
    try {
        console.log('Sending request with image to Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Describe in detail what is shown in this image'
                        },
                        {
                            type: 'image',
                            image: IMAGE_URL
                        }
                    ]
                }
            ],
            model: 'qwen3-235b-a22b', // Using model with image support
        });

        console.log('Response from Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nImage analysis successfully completed.');

    } catch (error) {
        console.error('Error executing request with image (Make sure image size does not exceed 10MB):', error);
    }
}

// Run
analyzeImage();
