// Example of direct API request to Qwen proxy using fetch
// To run the example: node fetch-example.js

async function directApiRequest() {
    try {
        console.log('Sending direct request to Qwen API...\n');

        const response = await fetch('http://localhost:3264/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: 'Explain in simple words, what is artificial intelligence',
                model: 'qwen-max-latest'
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const result = await response.json();

        console.log('Response from API:\n');
        console.log(result.choices[0].message.content);
        console.log('\nRequest successfully completed.');

        // Display additional information
        console.log('\nRequest info:');
        console.log(`Chat ID: ${result.chatId}`);
        console.log(`Model: ${result.model}`);

    } catch (error) {
        console.error('Error executing request:', error);
    }
}

// Run
directApiRequest();
